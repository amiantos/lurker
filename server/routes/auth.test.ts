// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-auth');

let app: Express;

beforeAll(async () => {
  const router = (await import('./auth.js')).default;
  app = createTestApp({ '/api/auth': router });
});

afterAll(() => ctx.cleanup());

describe('GET /api/auth/setup-status', () => {
  it('reports needsSetup=true on a fresh install (no users)', async () => {
    const res = await request(app).get('/api/auth/setup-status');
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
  });
});

describe('GET /api/auth/auth-methods (pre-setup)', () => {
  it('reports passkey=false when no credentials exist', async () => {
    const res = await request(app).get('/api/auth/auth-methods');
    expect(res.status).toBe(200);
    expect(res.body.passkey).toBe(false);
  });
});

describe('POST /api/auth/setup/password', () => {
  it('rejects an invalid username', async () => {
    const res = await request(app).post('/api/auth/setup/password').send({
      username: '!!bad!!', password: 'longenoughpw',
    });
    expect(res.status).toBe(400);
  });

  it('rejects too-short passwords', async () => {
    const res = await request(app).post('/api/auth/setup/password').send({
      username: 'firstadmin', password: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('creates the first admin and signs them in', async () => {
    const res = await request(app).post('/api/auth/setup/password').send({
      username: 'firstadmin', password: 'longenoughpw',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('firstadmin');
    expect(res.body.user.role).toBe('admin');
    expect((res.headers['set-cookie'] as unknown as string[] | undefined)?.some((c: string) => c.startsWith('lurker_session='))).toBe(true);
  });

  it('subsequent setup attempts return 409', async () => {
    const res = await request(app).post('/api/auth/setup/password').send({
      username: 'second', password: 'longenoughpw',
    });
    expect(res.status).toBe(409);
  });

  it('setup-status switches to false after the first user', async () => {
    const res = await request(app).get('/api/auth/setup-status');
    expect(res.body.needsSetup).toBe(false);
  });
});

describe('login / logout / me', () => {
  it('rejects unknown user + wrong password identically', async () => {
    const ghost = await request(app).post('/api/auth/login/password').send({
      username: 'ghost', password: 'doesnotmatter',
    });
    expect(ghost.status).toBe(401);
    const wrong = await request(app).post('/api/auth/login/password').send({
      username: 'firstadmin', password: 'wrong-password',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe(ghost.body.error);
  });

  it('rejects login when fields are missing or empty', async () => {
    const r1 = await request(app).post('/api/auth/login/password').send({});
    const r2 = await request(app).post('/api/auth/login/password').send({ username: 'firstadmin', password: '' });
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });

  it('valid password login issues a session cookie', async () => {
    const res = await request(app).post('/api/auth/login/password').send({
      username: 'firstadmin', password: 'longenoughpw',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('firstadmin');
    expect((res.headers['set-cookie'] as unknown as string[] | undefined)?.some((c: string) => c.startsWith('lurker_session='))).toBe(true);
  });

  it('/me requires auth', async () => {
    const res = await request(app).get('/api/auth/me');
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
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    // Should set the clearCookie header even when no token was present.
    expect((res.headers['set-cookie'] as unknown as string[] | undefined)?.some((c: string) => c.startsWith('lurker_session='))).toBe(true);
  });
});

describe('password management', () => {
  it('GET /api/auth/password requires auth', async () => {
    const res = await request(app).get('/api/auth/password');
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
    const fail = await request(app).post('/api/auth/login/password').send({
      username: 'firstadmin', password: 'longenoughpw',
    });
    expect(fail.status).toBe(401);
    // New one does.
    const ok = await request(app).post('/api/auth/login/password').send({
      username: 'firstadmin', password: 'newerpassword',
    });
    expect(ok.status).toBe(200);
  });

  it('PUT rejects too-short new password', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const agent = await createAuthedAgent(app, findUserByUsername('firstadmin')!.id);
    const res = await agent.put('/api/auth/password').send({
      currentPassword: 'newerpassword', password: 'short',
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
    const res = await request(app).get('/api/auth/passkeys');
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

describe('GET /api/auth/invite/:token', () => {
  it('valid:false for an unknown token', async () => {
    const res = await request(app).get('/api/auth/invite/no-such-token');
    expect(res.body).toEqual({ valid: false });
  });
});

describe('POST /api/auth/login/options', () => {
  it('409 when no passkeys exist', async () => {
    const res = await request(app).post('/api/auth/login/options');
    expect(res.status).toBe(409);
  });
});

describe('POST /api/auth/invite/:token/password', () => {
  it('404 for an invalid token', async () => {
    const res = await request(app).post('/api/auth/invite/bogus/password').send({
      username: 'someone', password: 'longenoughpw',
    });
    expect(res.status).toBe(404);
  });

  it('creates a new user when the invite is valid', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const { createInvite } = await import('../db/invites.js');
    const admin = findUserByUsername('firstadmin')!;
    const invite = createInvite(admin.id, { expiresInDays: 1 })!;
    const res = await request(app).post(`/api/auth/invite/${invite.token}/password`).send({
      username: 'invitee', password: 'longenoughpw',
    });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('invitee');
    expect(res.body.user.role).toBe('user');
  });

  it('rejects re-use of a consumed invite', async () => {
    const { findUserByUsername } = await import('../db/users.js');
    const { createInvite } = await import('../db/invites.js');
    const admin = findUserByUsername('firstadmin')!;
    const invite = createInvite(admin.id, { expiresInDays: 1 })!;
    const ok = await request(app).post(`/api/auth/invite/${invite.token}/password`).send({
      username: 'one-shot', password: 'longenoughpw',
    });
    expect(ok.status).toBe(200);
    const reuse = await request(app).post(`/api/auth/invite/${invite.token}/password`).send({
      username: 'two-shot', password: 'longenoughpw',
    });
    expect(reuse.status).toBe(404);
  });
});
