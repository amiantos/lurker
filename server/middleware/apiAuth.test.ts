// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { setupTestDb, testRequest } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { CreateTokenResult } from '../db/apiTokens.js';

const ctx = setupTestDb('middleware-api-auth');

let app: Express;
let createUser: typeof import('../db/users.js').createUser;
let createToken: typeof import('../db/apiTokens.js').createToken;
let revoke: typeof import('../db/apiTokens.js').revoke;
let deleteUser: typeof import('../db/users.js').deleteUser;

beforeAll(async () => {
  ({ createUser, deleteUser } = await import('../db/users.js'));
  ({ createToken, revoke } = await import('../db/apiTokens.js'));
  const { requireApiAuth } = await import('./apiAuth.js');
  app = express();
  app.use(express.json());
  app.get('/protected', requireApiAuth, (req, res) => {
    res.json({
      userId: req.user?.id,
      username: req.user?.username,
      hasSession: 'session' in req,
      tokenScope: req.apiToken?.scope,
    });
  });
});

afterAll(() => ctx.cleanup());

describe('requireApiAuth', () => {
  it('401 when Authorization header is missing', async () => {
    const res = await testRequest(app).get('/protected');
    expect(res.status).toBe(401);
  });

  it('401 when header is not Bearer-shaped', async () => {
    const res = await testRequest(app).get('/protected').set('Authorization', 'Basic foo');
    expect(res.status).toBe(401);
  });

  it('401 when token is bogus (no DB row)', async () => {
    const res = await testRequest(app)
      .get('/protected')
      .set('Authorization', 'Bearer notarealtoken');
    expect(res.status).toBe(401);
  });

  it('authenticates a valid token and populates req.user without req.session', async () => {
    const u: User = createUser('mw-alice');
    const t: CreateTokenResult = createToken({ userId: u.id, name: 'mw', scope: 'read-write' });
    const res = await testRequest(app).get('/protected').set('Authorization', `Bearer ${t.token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(u.id);
    expect(res.body.username).toBe('mw-alice');
    expect(res.body.tokenScope).toBe('read-write');
    expect(res.body.hasSession).toBe(false);
  });

  it('rejects a revoked token', async () => {
    const u: User = createUser('mw-bob');
    const t: CreateTokenResult = createToken({ userId: u.id, name: 'rev', scope: 'read' });
    revoke(t.id, u.id);
    const res = await testRequest(app).get('/protected').set('Authorization', `Bearer ${t.token}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token whose owning user has been deleted', async () => {
    const u: User = createUser('mw-carol');
    const t: CreateTokenResult = createToken({ userId: u.id, name: 'orphan', scope: 'read' });
    deleteUser(u.id);
    const res = await testRequest(app).get('/protected').set('Authorization', `Bearer ${t.token}`);
    expect(res.status).toBe(401);
  });

  it('passes scope through from token row', async () => {
    const u: User = createUser('mw-dave');
    const tRead: CreateTokenResult = createToken({ userId: u.id, name: 'r', scope: 'read' });
    const tRW: CreateTokenResult = createToken({ userId: u.id, name: 'rw', scope: 'read-write' });
    const r1 = await testRequest(app)
      .get('/protected')
      .set('Authorization', `Bearer ${tRead.token}`);
    const r2 = await testRequest(app).get('/protected').set('Authorization', `Bearer ${tRW.token}`);
    expect(r1.body.tokenScope).toBe('read');
    expect(r2.body.tokenScope).toBe('read-write');
  });
});
