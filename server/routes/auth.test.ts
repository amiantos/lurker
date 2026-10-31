// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  testRequest,
} from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-auth');

let app: Express;

beforeAll(async () => {
  const router = (await import('./auth.js')).default;
  app = createTestApp({ '/api/auth': router });
});

afterAll(() => ctx.cleanup());

describe('GET /api/auth/setup-status', () => {
  it('reports needsSetup=true on a fresh install (no users)', async () => {
    const res = await testRequest(app).get('/api/auth/setup-status');
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
  });
});

describe('GET /api/auth/auth-methods (pre-setup)', () => {
  it('reports passkey=false when no credentials exist', async () => {
    const res = await testRequest(app).get('/api/auth/auth-methods');
    expect(res.status).toBe(200);
    expect(res.body.passkey).toBe(false);
  });
});

describe('POST /api/auth/setup/password', () => {
  it('rejects an invalid username', async () => {
    const res = await testRequest(app).post('/api/auth/setup/password').send({
      username: '!!bad!!',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a username with a space', async () => {
    // The tightening: a space in a stored username makes 'bob smith', 'bobsmith'
    // and 'Bob Smith' three lookalike accounts, and it can't survive into the
    // identd ident either.
    const res = await testRequest(app).post('/api/auth/setup/password').send({
      username: 'bob smith',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(400);
  });

  it('rejects too-short passwords', async () => {
    const res = await testRequest(app).post('/api/auth/setup/password').send({
      username: 'firstadmin',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('creates the first admin and signs them in', async () => {
    const res = await testRequest(app).post('/api/auth/setup/password').send({
      username: 'firstadmin',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('firstadmin');
    expect(res.body.user.role).toBe('admin');
    expect(
      (res.headers['set-cookie'] as unknown as string[] | undefined)?.some((c: string) =>
        c.startsWith('lurker_session='),
      ),
    ).toBe(true);
  });

  it('subsequent setup attempts return 409', async () => {
    const res = await testRequest(app).post('/api/auth/setup/password').send({
      username: 'second',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(409);
  });

  it('setup-status switches to false after the first user', async () => {
    const res = await testRequest(app).get('/api/auth/setup-status');
    expect(res.body.needsSetup).toBe(false);
  });
});

describe('login / logout / me', () => {
  it('rejects unknown user + wrong password identically', async () => {
    const ghost = await testRequest(app).post('/api/auth/login/password').send({
      username: 'ghost',
      password: 'doesnotmatter',
    });
    expect(ghost.status).toBe(401);
    const wrong = await testRequest(app).post('/api/auth/login/password').send({
      username: 'firstadmin',
      password: 'wrong-password',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe(ghost.body.error);
  });

  it('rejects login when fields are missing or empty', async () => {
    const r1 = await testRequest(app).post('/api/auth/login/password').send({});
    const r2 = await testRequest(app)
      .post('/api/auth/login/password')
      .send({ username: 'firstadmin', password: '' });
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });

  it('logs in regardless of the case typed', async () => {
    // 'FirstAdmin' is the same account as 'firstadmin' — case is not identity.
    const res = await testRequest(app).post('/api/auth/login/password').send({
      username: 'FIRSTADMIN',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('firstadmin');
  });

  it('accepts a grandfathered username with a space at the login prompt', async () => {
    // Such an account can no longer be CREATED, but one that already exists must
    // still be able to authenticate — a 400 here would lock a real user out of
    // their own instance with no recourse but SQL.
    const db = (await import('../db/index.js')).default;
    const { setPasswordHash, findUserByUsername } = await import('../db/users.js');
    const { hashPassword } = await import('../services/password.js');
    db.prepare('INSERT INTO users (username, role) VALUES (?, ?)').run('legacy user', 'user');
    const legacy = findUserByUsername('legacy user')!;
    setPasswordHash(legacy.id, hashPassword('longenoughpw'));

    const res = await testRequest(app).post('/api/auth/login/password').send({
      username: 'legacy user',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('legacy user');
  });

  it('valid password login issues a session cookie', async () => {
    const res = await testRequest(app).post('/api/auth/login/password').send({
      username: 'firstadmin',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('firstadmin');
    expect(
      (res.headers['set-cookie'] as unknown as string[] | undefined)?.some((c: string) =>
        c.startsWith('lurker_session='),
      ),
    ).toBe(true);
  });

  it('/me requires auth', async () => {
    const res = await testRequest(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('/me returns the authed user', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const user = findUserByUsername('firstadmin')!;
    const agent = await createAuthedAgent(app, user.id);
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('firstadmin');
  });

  it('/logout clears the cookie', async () => {
    const res = await testRequest(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    // Should set the clearCookie header even when no token was present.
    expect(
      (res.headers['set-cookie'] as unknown as string[] | undefined)?.some((c: string) =>
        c.startsWith('lurker_session='),
      ),
    ).toBe(true);
  });
});

describe('password management', () => {
  it('GET /api/auth/password requires auth', async () => {
    const res = await testRequest(app).get('/api/auth/password');
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/password reports hasPassword=true after setup', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const agent = await createAuthedAgent(app, findUserByUsername('firstadmin')!.id);
    const res = await agent.get('/api/auth/password');
    expect(res.body.hasPassword).toBe(true);
  });

  it('PUT /api/auth/password requires current password when one exists', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const agent = await createAuthedAgent(app, findUserByUsername('firstadmin')!.id);
    const noCurrent = await agent.put('/api/auth/password').send({ password: 'newpassword' });
    expect(noCurrent.status).toBe(401);
  });

  it('PUT /api/auth/password rotates with correct current', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const agent = await createAuthedAgent(app, findUserByUsername('firstadmin')!.id);
    const res = await agent.put('/api/auth/password').send({
      currentPassword: 'longenoughpw',
      password: 'newerpassword',
    });
    expect(res.status).toBe(200);

    // Old password no longer works.
    const fail = await testRequest(app).post('/api/auth/login/password').send({
      username: 'firstadmin',
      password: 'longenoughpw',
    });
    expect(fail.status).toBe(401);
    // New one does.
    const ok = await testRequest(app).post('/api/auth/login/password').send({
      username: 'firstadmin',
      password: 'newerpassword',
    });
    expect(ok.status).toBe(200);
  });

  it('PUT rejects too-short new password', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const agent = await createAuthedAgent(app, findUserByUsername('firstadmin')!.id);
    const res = await agent.put('/api/auth/password').send({
      currentPassword: 'newerpassword',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/auth/password refuses when no other sign-in method exists', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const agent = await createAuthedAgent(app, findUserByUsername('firstadmin')!.id);
    const res = await agent.delete('/api/auth/password');
    expect(res.status).toBe(409);
  });
});

describe('GET /api/auth/passkeys', () => {
  it('requires auth', async () => {
    const res = await testRequest(app).get('/api/auth/passkeys');
    expect(res.status).toBe(401);
  });

  it('returns an empty list for a fresh password-only user', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const agent = await createAuthedAgent(app, findUserByUsername('firstadmin')!.id);
    const res = await agent.get('/api/auth/passkeys');
    expect(res.status).toBe(200);
    expect(res.body.passkeys).toEqual([]);
  });
});

describe('PATCH /api/auth/passkeys/:id', () => {
  // Every route that names a passkey reads the label the same way (#1038).
  it('caps a long label without splitting an emoji', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const { insertCredential, deleteById } = await import('../db/webauthnCredentials.js');
    const userId = findUserByUsername('firstadmin')!.id;
    const cred = insertCredential({
      userId,
      credentialId: 'cap-test',
      publicKey: Buffer.from('key'),
      counter: 0,
    })!;
    try {
      const agent = await createAuthedAgent(app, userId);
      const res = await agent
        .patch(`/api/auth/passkeys/${cred.id}`)
        .send({ label: 'x'.repeat(63) + '😀' });
      expect(res.status).toBe(200);
      const list = await agent.get('/api/auth/passkeys');
      expect(list.body.passkeys.map((p: { label: string }) => p.label)).toEqual(['x'.repeat(63)]);
    } finally {
      // Later tests count on there being no passkeys.
      deleteById(cred.id, userId);
    }
  });
});

describe('POST /api/auth/passkeys/options', () => {
  it('offers Ed25519, ES256 and RS256, never experimental ML-DSA', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const agent = await createAuthedAgent(app, findUserByUsername('firstadmin')!.id);
    const res = await agent.post('/api/auth/passkeys/options');
    expect(res.status).toBe(200);
    expect(res.body.options.pubKeyCredParams.map((p: { alg: number }) => p.alg)).toEqual([
      -8, -7, -257,
    ]);
  });
});

describe('GET /api/auth/invite/:token', () => {
  it('valid:false for an unknown token', async () => {
    const res = await testRequest(app).get('/api/auth/invite/no-such-token');
    expect(res.body).toEqual({ valid: false });
  });
});

describe('POST /api/auth/login/options', () => {
  it('409 when no passkeys exist', async () => {
    const res = await testRequest(app).post('/api/auth/login/options');
    expect(res.status).toBe(409);
  });
});

describe('POST /api/auth/invite/:token/password', () => {
  it('404 for an invalid token', async () => {
    const res = await testRequest(app).post('/api/auth/invite/bogus/password').send({
      username: 'someone',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(404);
  });

  it('creates a new user when the invite is valid', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const { createInvite } = await import('../db/invites.js');
    const admin = findUserByUsername('firstadmin')!;
    const invite = createInvite(admin.id, { expiresInDays: 1 })!;
    const res = await testRequest(app).post(`/api/auth/invite/${invite.token}/password`).send({
      username: 'invitee',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('invitee');
    expect(res.body.user.role).toBe('user');
  });

  // The account is born with the invite's restrictions: there is no moment in
  // which the new user could add Libera before an admin limited them.
  it('creates the account with the restrictions the invite carries', async () => {
    const { findUserByUsername, restrictionsOf } = await import('../db/users.js');
    const { createInvite } = await import('../db/invites.js');
    const admin = findUserByUsername('firstadmin')!;
    const held = { networks: ['irc.lurker.chat'], uploads: false };
    const invite = createInvite(admin.id, { expiresInDays: 1, restrictions: held })!;
    // The landing page can say what the account will be held to.
    const probe = await testRequest(app).get(`/api/auth/invite/${invite.token}`);
    expect(probe.body).toStrictEqual({ valid: true, restrictions: held });
    const res = await testRequest(app).post(`/api/auth/invite/${invite.token}/password`).send({
      username: 'born-held',
      password: 'longenoughpw',
    });
    expect(res.status).toBe(200);
    expect(restrictionsOf(findUserByUsername('born-held')!)).toStrictEqual(held);
  });

  // The passkey path creates the row at /options, before the credential
  // exists, so that is where the restrictions have to land.
  it('the passkey path creates the account with them too', async () => {
    const { findUserByUsername, restrictionsOf } = await import('../db/users.js');
    const { createInvite } = await import('../db/invites.js');
    const admin = findUserByUsername('firstadmin')!;
    const held = { networks: [], uploads: false };
    const invite = createInvite(admin.id, { expiresInDays: 1, restrictions: held })!;
    const res = await testRequest(app)
      .post(`/api/auth/invite/${invite.token}/options`)
      .send({ username: 'born-held-passkey' });
    expect(res.status).toBe(200);
    expect(restrictionsOf(findUserByUsername('born-held-passkey')!)).toStrictEqual(held);
  });

  it('rejects re-use of a consumed invite', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const { createInvite } = await import('../db/invites.js');
    const admin = findUserByUsername('firstadmin')!;
    const invite = createInvite(admin.id, { expiresInDays: 1 })!;
    const ok = await testRequest(app).post(`/api/auth/invite/${invite.token}/password`).send({
      username: 'one-shot',
      password: 'longenoughpw',
    });
    expect(ok.status).toBe(200);
    const reuse = await testRequest(app).post(`/api/auth/invite/${invite.token}/password`).send({
      username: 'two-shot',
      password: 'longenoughpw',
    });
    expect(reuse.status).toBe(404);
  });

  it('deleting the user who redeemed an invite does not reopen the link (#590)', async () => {
    const { findUserByUsername, deleteUser } = await import('../db/users.js');
    const { createInvite } = await import('../db/invites.js');
    const admin = findUserByUsername('firstadmin')!;
    const invite = createInvite(admin.id, { expiresInDays: 1 })!;
    const ok = await testRequest(app).post(`/api/auth/invite/${invite.token}/password`).send({
      username: 'later-removed',
      password: 'longenoughpw',
    });
    expect(ok.status).toBe(200);

    deleteUser(findUserByUsername('later-removed')!.id);

    // The redeemer column was ON DELETE SET NULL, so removing the account it let
    // in handed the one-time link back to anyone still holding the URL.
    const sneak = await testRequest(app).post(`/api/auth/invite/${invite.token}/password`).send({
      username: 'sneaked-in',
      password: 'longenoughpw',
    });
    expect(sneak.status).toBe(404);
    expect(findUserByUsername('sneaked-in')).toBeFalsy();
  });
});

// The native-app front door: password in, session token out, no browser needed.
//
// Owns its user rather than reusing `firstadmin`, whose password the
// password-management suite above rotates mid-file — these tests must not care
// what order they run in.
describe('POST /api/auth/login/token', () => {
  const USERNAME = 'nativeclient';
  const PASSWORD = 'nativepassword';

  beforeAll(async () => {
    const { createUser, setPasswordHash } = await import('../db/users.js');
    const { hashPassword } = await import('../services/password.js');
    const user = createUser(USERNAME);
    setPasswordHash(user.id, hashPassword(PASSWORD));
  });

  const mint = () =>
    testRequest(app).post('/api/auth/login/token').send({ username: USERNAME, password: PASSWORD });

  it('rejects a request with no credentials', async () => {
    const res = await testRequest(app).post('/api/auth/login/token').send({});
    expect(res.status).toBe(400);
  });

  it('rejects a wrong password', async () => {
    const res = await testRequest(app).post('/api/auth/login/token').send({
      username: USERNAME,
      password: 'notthepassword',
    });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  it('rejects an unknown user', async () => {
    const res = await testRequest(app).post('/api/auth/login/token').send({
      username: 'ghost',
      password: PASSWORD,
    });
    expect(res.status).toBe(401);
  });

  it('mints a token in the body and sets no cookie', async () => {
    const res = await mint();
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.user.username).toBe(USERNAME);
    // A native client has no cookie jar; handing it a Set-Cookie would be noise.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('mints a real session row — the token authenticates as a bearer', async () => {
    const res = await mint();
    const me = await testRequest(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe(USERNAME);
  });

  it('logout revokes the bearer session, so the token stops working', async () => {
    const token: string = (await mint()).body.token;

    const out = await testRequest(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(out.status).toBe(200);

    const after = await testRequest(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it('revoking one device leaves the others signed in', async () => {
    const phone: string = (await mint()).body.token;
    const laptop: string = (await mint()).body.token;
    expect(phone).not.toBe(laptop);

    await testRequest(app).post('/api/auth/logout').set('Authorization', `Bearer ${phone}`);

    const survivor = await testRequest(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${laptop}`);
    expect(survivor.status).toBe(200);
  });
});
