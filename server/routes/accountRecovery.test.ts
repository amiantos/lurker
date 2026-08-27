// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// End-to-end cover for admin-issued account recovery links (#855): an admin
// issues one, the locked-out member redeems it, and every session that predated
// the recovery dies. Both routers are mounted so the loop runs as it does in
// production rather than through hand-built rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  testRequest,
} from '../test-utils/testApp.js';
import type { LurkerTestAgent } from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-account-recovery');

let app: Express;
let adminAgent: LurkerTestAgent;
let createUser: typeof import('../db/users.js').createUser;
let setPasswordHash: typeof import('../db/users.js').setPasswordHash;
let getPasswordHash: typeof import('../db/users.js').getPasswordHash;
let hashPassword: typeof import('../services/password.js').hashPassword;
let verifyPassword: typeof import('../services/password.js').verifyPassword;
let recovery: typeof import('../db/accountRecovery.js');
let admin: ReturnType<typeof import('../db/users.js').createUser>;

// Issue a link for `userId` as the admin and hand back its raw token.
async function issue(userId: number): Promise<{ token: string; url: string; status: number }> {
  const res = await adminAgent.post(`/api/admin/users/${userId}/recovery`);
  const url: string = res.body?.recovery?.url ?? '';
  return { token: url.split('/recover/')[1] ?? '', url, status: res.status };
}

beforeAll(async () => {
  ({ createUser, setPasswordHash, getPasswordHash } = await import('../db/users.js'));
  ({ hashPassword, verifyPassword } = await import('../services/password.js'));
  recovery = await import('../db/accountRecovery.js');
  const authRouter = (await import('./auth.js')).default;
  const adminRouter = (await import('./admin.js')).default;
  app = createTestApp({ '/api/auth': authRouter, '/api/admin': adminRouter });
  admin = createUser('recovery-admin', { role: 'admin' });
  adminAgent = await createAuthedAgent(app, admin.id);
});

afterAll(() => ctx.cleanup());

describe('POST /api/admin/users/:id/recovery', () => {
  it('issues a link, and the URL is the only place the token exists', async () => {
    const u = createUser('link-issued');
    const { status, url, token } = await issue(u.id);
    expect(status).toBe(200);
    expect(url).toContain(`/recover/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // Stored hashed: the admin listing can say a link is outstanding but can
    // never re-show it.
    expect(recovery.getRecoveryTokenForUser(u.id)).toMatchObject({ createdBy: admin.id });
    const list = await adminAgent.get('/api/admin/users');
    const row = list.body.users.find((r: { id: number }) => r.id === u.id);
    expect(row.recoveryExpiresAt).toBeTruthy();
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it('reports every outstanding link in one listing', async () => {
    const a = createUser('listing-a');
    const b = createUser('listing-b');
    const none = createUser('listing-none');
    await issue(a.id);
    await issue(b.id);
    const list = await adminAgent.get('/api/admin/users');
    const row = (id: number) => list.body.users.find((r: { id: number }) => r.id === id);
    expect(row(a.id).recoveryExpiresAt).toBeTruthy();
    expect(row(b.id).recoveryExpiresAt).toBeTruthy();
    expect(row(none.id).recoveryExpiresAt).toBeNull();
  });

  it('404s for an account that does not exist', async () => {
    const res = await adminAgent.post('/api/admin/users/999999/recovery');
    expect(res.status).toBe(404);
  });

  it('is refused for a non-admin', async () => {
    const member = createUser('link-nonadmin');
    const target = createUser('link-nonadmin-target');
    const memberAgent = await createAuthedAgent(app, member.id);
    const res = await memberAgent.post(`/api/admin/users/${target.id}/recovery`);
    expect(res.status).toBe(403);
    expect(recovery.getRecoveryTokenForUser(target.id)).toBeNull();
  });

  it('is refused for an anonymous caller', async () => {
    const target = createUser('link-anon-target');
    const res = await testRequest(app).post(`/api/admin/users/${target.id}/recovery`);
    expect(res.status).toBe(401);
    expect(recovery.getRecoveryTokenForUser(target.id)).toBeNull();
  });

  it('re-issuing invalidates the previous link', async () => {
    const u = createUser('link-reissued');
    const first = await issue(u.id);
    const second = await issue(u.id);
    expect(second.token).not.toBe(first.token);
    const probe = await testRequest(app).get(`/api/auth/recovery/${first.token}`);
    expect(probe.body.valid).toBe(false);
    const live = await testRequest(app).get(`/api/auth/recovery/${second.token}`);
    expect(live.body.valid).toBe(true);
  });
});

describe('DELETE /api/admin/users/:id/recovery', () => {
  it('revokes an outstanding link', async () => {
    const u = createUser('link-revoked');
    const { token } = await issue(u.id);
    const res = await adminAgent.delete(`/api/admin/users/${u.id}/recovery`);
    expect(res.status).toBe(200);
    const probe = await testRequest(app).get(`/api/auth/recovery/${token}`);
    expect(probe.body.valid).toBe(false);
  });

  it('404s when there is nothing outstanding', async () => {
    const u = createUser('link-nothing-to-revoke');
    const res = await adminAgent.delete(`/api/admin/users/${u.id}/recovery`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/auth/recovery/:token', () => {
  it('names the account and reports whether it already has a password', async () => {
    const u = createUser('probe-target');
    setPasswordHash(u.id, hashPassword('originalpassword'));
    const { token } = await issue(u.id);
    const res = await testRequest(app).get(`/api/auth/recovery/${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, username: 'probe-target', hasPassword: true });
  });

  it('answers an unknown token exactly as it answers an expired one', async () => {
    const u = createUser('probe-expired');
    // Backdate the row rather than waiting out the 24h TTL.
    const { token } = await issue(u.id);
    const { default: db } = await import('../db/index.js');
    db.prepare('UPDATE account_recovery_tokens SET expires_at = ? WHERE user_id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      u.id,
    );
    const expired = await testRequest(app).get(`/api/auth/recovery/${token}`);
    const unknown = await testRequest(app).get('/api/auth/recovery/not-a-real-token');
    expect(expired.body).toEqual({ valid: false });
    expect(unknown.body).toEqual(expired.body);
  });

  it('does not spend the link', async () => {
    const u = createUser('probe-nondestructive');
    const { token } = await issue(u.id);
    await testRequest(app).get(`/api/auth/recovery/${token}`);
    await testRequest(app).get(`/api/auth/recovery/${token}`);
    const res = await testRequest(app)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'a-fresh-password' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/recovery/:token/password', () => {
  it('sets the new password and signs the redeeming device in', async () => {
    const u = createUser('redeem-happy');
    setPasswordHash(u.id, hashPassword('theoldpassword'));
    const { token } = await issue(u.id);
    const res = await testRequest(app)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'thenewpassword' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: u.id, username: 'redeem-happy' });
    expect(String(res.headers['set-cookie'])).toContain('lurker_session=');
    const stored = getPasswordHash(u.id);
    expect(verifyPassword('thenewpassword', stored)).toBe(true);
    expect(verifyPassword('theoldpassword', stored)).toBe(false);
  });

  it('works for an account that had no password at all', async () => {
    // The passkey-only member who lost their phone: nothing to "reset", so a
    // password-only reset flow would have stranded them.
    const u = createUser('redeem-no-password');
    const { token } = await issue(u.id);
    const res = await testRequest(app)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'firstpasswordever' });
    expect(res.status).toBe(200);
    expect(verifyPassword('firstpasswordever', getPasswordHash(u.id))).toBe(true);
  });

  it('signs every other device out', async () => {
    const u = createUser('redeem-revokes');
    const oldDevice = await createAuthedAgent(app, u.id);
    expect((await oldDevice.get('/api/auth/me')).status).toBe(200);
    const { token } = await issue(u.id);
    await testRequest(app)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'kickeveryoneout' });
    // The lockout that made recovery necessary is indistinguishable from a
    // takeover, so a session predating it is assumed hostile.
    expect((await oldDevice.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a too-short password WITHOUT burning the link', async () => {
    const u = createUser('redeem-short');
    const { token } = await issue(u.id);
    const bad = await testRequest(app)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'short' });
    expect(bad.status).toBe(400);
    // A single-use link must survive a typo, or the admin has to issue another.
    const good = await testRequest(app)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'longenoughpassword' });
    expect(good.status).toBe(200);
  });

  it('cannot be redeemed twice', async () => {
    const u = createUser('redeem-twice');
    const { token } = await issue(u.id);
    const first = await testRequest(app)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'thefirstpassword' });
    expect(first.status).toBe(200);
    const second = await testRequest(app)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'thesecondpassword' });
    expect(second.status).toBe(400);
    // The password from the winning redemption is the one that stands.
    expect(verifyPassword('thefirstpassword', getPasswordHash(u.id))).toBe(true);
  });

  it('rejects an unknown token', async () => {
    const res = await testRequest(app)
      .post('/api/auth/recovery/nope/password')
      .send({ password: 'longenoughpassword' });
    expect(res.status).toBe(400);
  });

  it('still works for an IP already throttled by failed logins', async () => {
    // The regression this route's missing guardCredentialAttempt prevents:
    // failing at sign-in is HOW someone ends up needing recovery, so a shared
    // login backoff would 429 exactly the person the link was issued for.
    const u = createUser('redeem-throttled');
    setPasswordHash(u.id, hashPassword('theoldpassword'));
    const { token } = await issue(u.id);
    for (let i = 0; i < 12; i++) {
      await testRequest(app)
        .post('/api/auth/login/password')
        .send({ username: 'redeem-throttled', password: 'wrongpassword' });
    }
    // Sign-in is now backed off for this IP...
    const blocked = await testRequest(app)
      .post('/api/auth/login/password')
      .send({ username: 'redeem-throttled', password: 'theoldpassword' });
    expect(blocked.status).toBe(429);
    // ...and recovery still lets them back in.
    const res = await testRequest(app)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'thenewpassword' });
    expect(res.status).toBe(200);
  });

  it('leaves existing passkeys alone', async () => {
    // Recovery restores a way in; it is not a way to strip someone's
    // credentials out from under them.
    const u = createUser('redeem-keeps-passkeys');
    const { insertCredential, countForUser } = await import('../db/webauthnCredentials.js');
    insertCredential({
      userId: u.id,
      credentialId: 'cred-kept-through-recovery',
      publicKey: Buffer.from('key'),
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false,
      label: 'old laptop',
    });
    const { token } = await issue(u.id);
    await testRequest(app)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'passwordalongside' });
    expect(countForUser(u.id)).toBe(1);
  });
});

describe('spendRecoveryAndEnroll', () => {
  it('rolls the spend back when the passkey is already registered elsewhere', async () => {
    // credential_id is UNIQUE across the instance while the ceremony only
    // excludes THIS account's keys, so an authenticator enrolled on another
    // account here clears WebAuthn and then fails the insert. If that spent the
    // link, the member would be left with no passkey and no way back in.
    const other = createUser('enroll-owner');
    const u = createUser('enroll-clash');
    const { insertCredential, countForUser } = await import('../db/webauthnCredentials.js');
    insertCredential({
      userId: other.id,
      credentialId: 'cred-owned-by-someone-else',
      publicKey: Buffer.from('key'),
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false,
      label: null,
    });
    const { token } = await issue(u.id);
    expect(() =>
      recovery.spendRecoveryAndEnroll(token, u.id, {
        credentialId: 'cred-owned-by-someone-else',
        publicKey: Buffer.from('key'),
        counter: 0,
        transports: ['internal'],
        deviceType: 'singleDevice',
        backedUp: false,
        label: null,
      }),
    ).toThrow(/UNIQUE constraint failed/);
    // The link survives, so they can retry with a different authenticator.
    expect(recovery.findLiveRecoveryToken(token)).toMatchObject({ userId: u.id });
    expect(countForUser(u.id)).toBe(0);
  });

  it('enrolls and spends together on the happy path', async () => {
    const u = createUser('enroll-happy');
    const { countForUser } = await import('../db/webauthnCredentials.js');
    const { token } = await issue(u.id);
    expect(
      recovery.spendRecoveryAndEnroll(token, u.id, {
        credentialId: 'cred-enrolled-by-recovery',
        publicKey: Buffer.from('key'),
        counter: 0,
        transports: ['internal'],
        deviceType: 'singleDevice',
        backedUp: false,
        label: null,
      }),
    ).toBe(u.id);
    expect(countForUser(u.id)).toBe(1);
    expect(recovery.findLiveRecoveryToken(token)).toBeNull();
  });

  it('refuses a link belonging to a different account than the challenge', async () => {
    const u = createUser('enroll-pinned');
    const other = createUser('enroll-pinned-other');
    const { token } = await issue(u.id);
    expect(
      recovery.spendRecoveryAndEnroll(token, other.id, {
        credentialId: 'cred-never-written',
        publicKey: Buffer.from('key'),
        counter: 0,
        transports: ['internal'],
        deviceType: 'singleDevice',
        backedUp: false,
        label: null,
      }),
    ).toBeNull();
    expect(recovery.findLiveRecoveryToken(token)).toMatchObject({ userId: u.id });
  });
});

describe('POST /api/auth/recovery/:token/options', () => {
  it('returns registration options for the account named by the link', async () => {
    const u = createUser('passkey-options');
    const { token } = await issue(u.id);
    const res = await testRequest(app).post(`/api/auth/recovery/${token}/options`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('passkey-options');
    expect(res.body.options.challenge).toBeTruthy();
    expect(String(res.headers['set-cookie'])).toContain('lurker_webauthn_challenge=');
  });

  it('excludes passkeys already on the account', async () => {
    const u = createUser('passkey-options-exclude');
    const { insertCredential } = await import('../db/webauthnCredentials.js');
    insertCredential({
      userId: u.id,
      credentialId: 'cred-already-enrolled',
      publicKey: Buffer.from('key'),
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false,
      label: null,
    });
    const { token } = await issue(u.id);
    const res = await testRequest(app).post(`/api/auth/recovery/${token}/options`);
    expect(res.body.options.excludeCredentials).toEqual([
      { id: 'cred-already-enrolled', transports: ['internal'], type: 'public-key' },
    ]);
  });

  it('does not spend the link — the ceremony may still be abandoned', async () => {
    const u = createUser('passkey-options-nondestructive');
    const { token } = await issue(u.id);
    await testRequest(app).post(`/api/auth/recovery/${token}/options`);
    expect(recovery.findLiveRecoveryToken(token)).toMatchObject({ userId: u.id });
  });

  it('404s for an invalid link', async () => {
    const res = await testRequest(app).post('/api/auth/recovery/nope/options');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/recovery/:token/verify', () => {
  it('refuses without a pending challenge', async () => {
    const u = createUser('passkey-verify-nochallenge');
    const { token } = await issue(u.id);
    const res = await testRequest(app).post(`/api/auth/recovery/${token}/verify`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no pending recovery');
    // And the link is untouched, so the member can try again.
    expect(recovery.findLiveRecoveryToken(token)).toMatchObject({ userId: u.id });
  });

  it('refuses a challenge issued for a different link', async () => {
    const u = createUser('passkey-verify-crosslink');
    const other = createUser('passkey-verify-crosslink-other');
    const mine = await issue(u.id);
    const theirs = await issue(other.id);
    const agent = (await import('../test-utils/testApp.js')).createAnonAgent(app);
    await agent.post(`/api/auth/recovery/${mine.token}/options`);
    // Same browser, same challenge cookie, pointed at someone else's link.
    const res = await agent.post(`/api/auth/recovery/${theirs.token}/verify`).send({});
    expect(res.status).toBe(400);
    expect(recovery.findLiveRecoveryToken(theirs.token)).toBeTruthy();
  });

  it('does not spend the link when the authenticator response fails to verify', async () => {
    const u = createUser('passkey-verify-badresponse');
    const { token } = await issue(u.id);
    const agent = (await import('../test-utils/testApp.js')).createAnonAgent(app);
    await agent.post(`/api/auth/recovery/${token}/options`);
    const res = await agent.post(`/api/auth/recovery/${token}/verify`).send({ response: {} });
    expect(res.status).toBe(400);
    // A failed ceremony must not cost the member their one link.
    expect(recovery.findLiveRecoveryToken(token)).toMatchObject({ userId: u.id });
  });
});
