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
let createSession: typeof import('../db/sessions.js').createSession;
let oauth: typeof import('../db/oauth.js');

beforeAll(async () => {
  ({ createUser, deleteUser } = await import('../db/users.js'));
  ({ createToken, revoke } = await import('../db/apiTokens.js'));
  ({ createSession } = await import('../db/sessions.js'));
  oauth = await import('../db/oauth.js');
  const { requireApiAuth } = await import('./apiAuth.js');
  app = express();
  app.use(express.json());
  app.get('/protected', requireApiAuth, (req, res) => {
    res.json({
      userId: req.user?.id,
      username: req.user?.username,
      hasSession: 'session' in req,
      tokenScope: req.apiToken?.scope,
      oauthTokenId: req.oauthToken?.id,
    });
  });
});

afterAll(() => ctx.cleanup());

function oauthTokenFor(userId: number): string {
  const oauthApp = oauth.createApp({
    clientName: 'MCP client',
    clientUri: null,
    redirectUris: ['urn:ietf:wg:oauth:2.0:oob'],
  });
  return oauth.createToken(oauthApp.id, userId);
}

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

  // #891: an MCP client that signs in through OAuth comes back with an access
  // token. Refusing it sends the client round the approval again.
  it('authenticates an OAuth access token as the member, without an API token', async () => {
    const u: User = createUser('mw-oauth');
    const token = oauthTokenFor(u.id);
    const res = await testRequest(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(u.id);
    expect(res.body.oauthTokenId).toBe(oauth.findTokenByRaw(token)?.id);
    expect(res.body.tokenScope).toBeUndefined();
    expect(res.body.hasSession).toBe(false);
  });

  it('rejects a revoked OAuth access token', async () => {
    const u: User = createUser('mw-oauth-revoked');
    const token = oauthTokenFor(u.id);
    oauth.deleteTokenByRaw(token);
    const res = await testRequest(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('still refuses a session token', async () => {
    const u: User = createUser('mw-session');
    const { token } = createSession(u.id);
    const res = await testRequest(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
