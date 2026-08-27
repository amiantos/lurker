// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-recovery-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let recovery: typeof import('./accountRecovery.js');
let createUser: typeof import('./users.js').createUser;
let db: typeof import('./index.js').default;
let admin: ReturnType<typeof import('./users.js').createUser>;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  recovery = await import('./accountRecovery.js');
  ({ createUser } = await import('./users.js'));
  ({ default: db } = await import('./index.js'));
  admin = createUser('r-admin', { role: 'admin' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('createRecoveryToken', () => {
  it('returns a high-entropy base64url token and stores only its hash', () => {
    const u = createUser('r-hash');
    const token = recovery.createRecoveryToken(u.id, admin.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    // The raw token must not appear anywhere in the row -- a read of this table
    // is not supposed to be enough to recover the account.
    const row = db
      .prepare('SELECT * FROM account_recovery_tokens WHERE user_id = ?')
      .get(u.id) as Record<string, unknown>;
    expect(Object.values(row)).not.toContain(token);
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('expires 24 hours out', () => {
    const u = createUser('r-ttl');
    const now = Date.UTC(2026, 0, 1);
    recovery.createRecoveryToken(u.id, admin.id, now);
    const info = recovery.getRecoveryTokenForUser(u.id, now)!;
    expect(Date.parse(info.expiresAt) - now).toBe(DAY);
  });

  it('issuing a new link invalidates the outstanding one', () => {
    const u = createUser('r-replace');
    const first = recovery.createRecoveryToken(u.id, admin.id);
    const second = recovery.createRecoveryToken(u.id, admin.id);
    expect(second).not.toBe(first);
    expect(recovery.findLiveRecoveryToken(first)).toBeNull();
    expect(recovery.findLiveRecoveryToken(second)).toMatchObject({ userId: u.id });
    // One row per account, always.
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM account_recovery_tokens WHERE user_id = ?')
      .get(u.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it('records the issuing admin, and tolerates the CLI issuing anonymously', () => {
    const u = createUser('r-issuer');
    recovery.createRecoveryToken(u.id, admin.id);
    expect(recovery.getRecoveryTokenForUser(u.id)!.createdBy).toBe(admin.id);
    recovery.createRecoveryToken(u.id, null);
    expect(recovery.getRecoveryTokenForUser(u.id)!.createdBy).toBeNull();
  });
});

describe('findLiveRecoveryToken', () => {
  it('finds a live token by its raw value', () => {
    const u = createUser('r-find');
    const token = recovery.createRecoveryToken(u.id, admin.id);
    expect(recovery.findLiveRecoveryToken(token)).toMatchObject({
      userId: u.id,
      createdBy: admin.id,
    });
  });

  it('returns null for unknown, empty, and expired tokens alike', () => {
    const u = createUser('r-find-dead');
    const now = Date.UTC(2026, 0, 1);
    const token = recovery.createRecoveryToken(u.id, admin.id, now);
    expect(recovery.findLiveRecoveryToken('nope')).toBeNull();
    expect(recovery.findLiveRecoveryToken('')).toBeNull();
    expect(recovery.findLiveRecoveryToken(null)).toBeNull();
    expect(recovery.findLiveRecoveryToken(token, now + DAY + 1)).toBeNull();
  });

  it('does not spend the token', () => {
    const u = createUser('r-probe');
    const token = recovery.createRecoveryToken(u.id, admin.id);
    recovery.findLiveRecoveryToken(token);
    recovery.findLiveRecoveryToken(token);
    expect(recovery.consumeRecoveryToken(token)).toBe(u.id);
  });
});

describe('consumeRecoveryToken', () => {
  it('spends a live token exactly once', () => {
    const u = createUser('r-consume');
    const token = recovery.createRecoveryToken(u.id, admin.id);
    expect(recovery.consumeRecoveryToken(token)).toBe(u.id);
    // The second attempt is the one a leaked link would make.
    expect(recovery.consumeRecoveryToken(token)).toBeNull();
    expect(recovery.findLiveRecoveryToken(token)).toBeNull();
  });

  it('refuses an expired token', () => {
    const u = createUser('r-consume-expired');
    const now = Date.UTC(2026, 0, 1);
    const token = recovery.createRecoveryToken(u.id, admin.id, now);
    expect(recovery.consumeRecoveryToken(token, now + DAY + 1)).toBeNull();
    // Still live a minute before the deadline.
    const fresh = recovery.createRecoveryToken(u.id, admin.id, now);
    expect(recovery.consumeRecoveryToken(fresh, now + DAY - 60_000)).toBe(u.id);
  });

  it('refuses an unknown token', () => {
    expect(recovery.consumeRecoveryToken('not-a-token')).toBeNull();
  });
});

describe('deleteRecoveryTokensForUser', () => {
  it('revokes an outstanding link and reports whether there was one', () => {
    const u = createUser('r-revoke');
    recovery.createRecoveryToken(u.id, admin.id);
    expect(recovery.deleteRecoveryTokensForUser(u.id)).toBe(true);
    expect(recovery.getRecoveryTokenForUser(u.id)).toBeNull();
    expect(recovery.deleteRecoveryTokensForUser(u.id)).toBe(false);
  });
});

describe('purgeExpiredRecoveryTokens', () => {
  it('drops expired rows and keeps live ones', () => {
    const stale = createUser('r-purge-stale');
    const live = createUser('r-purge-live');
    const now = Date.UTC(2026, 0, 1);
    recovery.createRecoveryToken(stale.id, admin.id, now);
    const liveToken = recovery.createRecoveryToken(live.id, admin.id, now + DAY);
    recovery.purgeExpiredRecoveryTokens(now + DAY + 1);
    expect(
      db.prepare('SELECT 1 FROM account_recovery_tokens WHERE user_id = ?').get(stale.id),
    ).toBeUndefined();
    expect(recovery.findLiveRecoveryToken(liveToken, now + DAY + 1)).toMatchObject({
      userId: live.id,
    });
  });
});

describe('foreign keys', () => {
  it('deleting the account wipes its link', () => {
    const u = createUser('r-cascade');
    const token = recovery.createRecoveryToken(u.id, admin.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    expect(recovery.findLiveRecoveryToken(token)).toBeNull();
  });

  it('deleting the issuing admin leaves the link usable', () => {
    // An admin leaving must not strand a member mid-recovery -- the link belongs
    // to the account being recovered, not to whoever issued it.
    const issuer = createUser('r-departing-admin', { role: 'admin' });
    const u = createUser('r-orphaned-link');
    const token = recovery.createRecoveryToken(u.id, issuer.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(issuer.id);
    expect(recovery.findLiveRecoveryToken(token)).toMatchObject({ userId: u.id, createdBy: null });
    expect(recovery.consumeRecoveryToken(token)).toBe(u.id);
  });
});
