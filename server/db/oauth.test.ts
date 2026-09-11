// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Storage for the OAuth authorization server (#891): single-use codes, hashed
// tokens, revocation that takes codes along with tokens, and the purge that
// bounds what the open registration endpoint lets anyone write.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('db-oauth');

let oauth: typeof import('./oauth.js');
let users: typeof import('./users.js');
let db: typeof import('./index.js').default;

beforeAll(async () => {
  oauth = await import('./oauth.js');
  users = await import('./users.js');
  db = (await import('./index.js')).default;
});

afterAll(() => ctx.cleanup());

const OOB = 'urn:ietf:wg:oauth:2.0:oob';
const CHALLENGE = 'c'.repeat(43);

function newApp(name = 'Test app', now?: number) {
  return oauth.createApp({ clientName: name, clientUri: null, redirectUris: [OOB] }, now);
}

function codeFor(appId: number, userId: number, now?: number): string {
  return oauth.createCode({ appId, userId, redirectUri: OOB, codeChallenge: CHALLENGE }, now);
}

function codeRowExists(code: string): boolean {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM oauth_codes WHERE code_hash = ?')
    .get(oauth.hashSecret(code)) as { n: number };
  return row.n > 0;
}

describe('authorization codes', () => {
  it('can be spent exactly once', () => {
    const user = users.createUser('oauth-code-once');
    const app = newApp();
    const code = codeFor(app.id, user.id);
    expect(oauth.consumeCode(code)).toEqual({
      appId: app.id,
      userId: user.id,
      redirectUri: OOB,
      codeChallenge: CHALLENGE,
    });
    expect(oauth.consumeCode(code)).toBeNull();
  });

  it('stop working once they expire', () => {
    const now = Date.now();
    const user = users.createUser('oauth-code-expired');
    const code = codeFor(newApp().id, user.id, now);
    expect(oauth.consumeCode(code, now + oauth.CODE_TTL_MS + 1)).toBeNull();
  });

  it('are stored only as a hash', () => {
    const user = users.createUser('oauth-code-hashed');
    const code = codeFor(newApp().id, user.id);
    const raw = db.prepare('SELECT 1 FROM oauth_codes WHERE code_hash = ?').get(code);
    expect(raw).toBeUndefined();
    expect(codeRowExists(code)).toBe(true);
  });

  it('mark the app as approved, which exempts it from the pending purge', () => {
    const user = users.createUser('oauth-code-approves');
    const app = newApp();
    expect(oauth.findAppByClientId(app.clientId)?.firstAuthorizedAt).toBeNull();
    codeFor(app.id, user.id);
    expect(oauth.findAppByClientId(app.clientId)?.firstAuthorizedAt).not.toBeNull();
  });
});

describe('access tokens', () => {
  it('are found by raw value and stored only as a hash', () => {
    const user = users.createUser('oauth-token-find');
    const app = newApp();
    const token = oauth.createToken(app.id, user.id);
    expect(oauth.findTokenByRaw(token)).toMatchObject({ appId: app.id, userId: user.id });
    expect(
      db.prepare('SELECT 1 FROM oauth_tokens WHERE token_hash = ?').get(token),
    ).toBeUndefined();
  });

  it('can only be revoked by the client they were issued to', () => {
    const user = users.createUser('oauth-token-client');
    const mine = newApp('Mine');
    const theirs = newApp('Theirs');
    const token = oauth.createToken(mine.id, user.id);
    expect(oauth.deleteTokenForClient(token, theirs.clientId)).toBeNull();
    expect(oauth.findTokenByRaw(token)).not.toBeNull();
    expect(oauth.deleteTokenForClient(token, mine.clientId)).toMatchObject({ userId: user.id });
    expect(oauth.findTokenByRaw(token)).toBeNull();
  });

  it('revoking an app for one member takes its codes too, and nothing else', () => {
    const alice = users.createUser('oauth-revoke-alice');
    const bob = users.createUser('oauth-revoke-bob');
    const app = newApp('Revoked');
    const other = newApp('Untouched');
    const aliceToken = oauth.createToken(app.id, alice.id);
    const bobToken = oauth.createToken(app.id, bob.id);
    const aliceOther = oauth.createToken(other.id, alice.id);
    const pendingCode = codeFor(app.id, alice.id);

    const ids = oauth.deleteOAuthForApp(alice.id, app.id);
    expect(ids).toHaveLength(1);
    expect(oauth.findTokenByRaw(aliceToken)).toBeNull();
    // A code approved before the revoke must not mint a token after it.
    expect(codeRowExists(pendingCode)).toBe(false);
    expect(oauth.findTokenByRaw(bobToken)).not.toBeNull();
    expect(oauth.findTokenByRaw(aliceOther)).not.toBeNull();
  });

  it('revoking everything for a member (account recovery) takes every token and code', () => {
    const user = users.createUser('oauth-revoke-all');
    const bystander = users.createUser('oauth-revoke-bystander');
    const app = newApp();
    const tokens = [oauth.createToken(app.id, user.id), oauth.createToken(newApp().id, user.id)];
    const code = codeFor(app.id, user.id);
    const kept = oauth.createToken(app.id, bystander.id);

    expect(oauth.deleteOAuthForUser(user.id)).toHaveLength(2);
    for (const token of tokens) expect(oauth.findTokenByRaw(token)).toBeNull();
    expect(codeRowExists(code)).toBe(false);
    expect(oauth.findTokenByRaw(kept)).not.toBeNull();
  });

  it('go with a deleted account', () => {
    const user = users.createUser('oauth-deleted-user');
    const app = newApp();
    const token = oauth.createToken(app.id, user.id);
    const code = codeFor(app.id, user.id);
    users.deleteUser(user.id);
    expect(oauth.findTokenByRaw(token)).toBeNull();
    expect(codeRowExists(code)).toBe(false);
  });
});

describe('listAuthorizedApps', () => {
  it('lists each app once, with its first authorization and latest use', () => {
    const user = users.createUser('oauth-list');
    const app = oauth.createApp({
      clientName: 'Listed',
      clientUri: 'https://listed.example',
      redirectUris: [OOB],
    });
    const first = oauth.createToken(app.id, user.id, Date.parse('2026-01-01T00:00:00.000Z'));
    oauth.createToken(app.id, user.id, Date.parse('2026-02-01T00:00:00.000Z'));
    oauth.touchTokenLastUsed(oauth.findTokenByRaw(first)!.id);

    const apps = oauth.listAuthorizedApps(user.id);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      id: app.id,
      name: 'Listed',
      clientUri: 'https://listed.example',
      authorizedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(apps[0].lastUsedAt).not.toBeNull();
  });

  it('leaves out apps the member holds no token for', () => {
    const user = users.createUser('oauth-list-empty');
    codeFor(newApp('Approved but never exchanged').id, user.id);
    expect(oauth.listAuthorizedApps(user.id)).toEqual([]);
  });
});

describe('purgeOAuth', () => {
  it('drops expired codes and stale unapproved registrations, and nothing else', () => {
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    const user = users.createUser('oauth-purge');
    const stale = newApp('Stale', now - oauth.PENDING_APP_TTL_MS - 1);
    const fresh = newApp('Fresh', now - 1000);
    const approved = newApp('Approved long ago', now - oauth.PENDING_APP_TTL_MS * 10);
    const liveCode = codeFor(approved.id, user.id, now);
    const expiredCode = codeFor(approved.id, user.id, now - oauth.CODE_TTL_MS - 1);

    oauth.purgeOAuth(now);

    expect(oauth.findAppByClientId(stale.clientId)).toBeNull();
    expect(oauth.findAppByClientId(fresh.clientId)).not.toBeNull();
    expect(oauth.findAppByClientId(approved.clientId)).not.toBeNull();
    expect(codeRowExists(liveCode)).toBe(true);
    expect(codeRowExists(expiredCode)).toBe(false);
  });
});
