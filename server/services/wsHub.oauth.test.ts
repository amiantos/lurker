// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Revoking an OAuth app (#891) has to reach the sockets its token already opened:
// a socket authenticates at the upgrade and is never checked again, so deleting
// the token alone would leave a revoked app streaming. Real sockets against a real
// hub, like wsHub.revoke.test.ts, because that is the only way to observe it.
//
// Tokens are minted straight from storage here. The HTTP flow that produces them
// is covered in routes/oauth.test.ts; this file is about what revoking does.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createTestApp, setupTestDb, TEST_SESSION_SECRET } from '../test-utils/testApp.js';
import { WS_CLOSE_SESSION_REVOKED } from '../../shared/wsCloseCodes.js';

const testDb = setupTestDb('wshub-oauth');

const OOB = 'urn:ietf:wg:oauth:2.0:oob';

let server: http.Server;
let url: string;
let createUser: typeof import('../db/users.js').createUser;
let createSession: typeof import('../db/sessions.js').createSession;
let oauth: typeof import('../db/oauth.js');

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createSession } = await import('../db/sessions.js'));
  oauth = await import('../db/oauth.js');
  const wsHub = await import('./wsHub.js');
  const { oauthRouter } = await import('../routes/oauth.js');
  const authRouter = (await import('../routes/auth.js')).default;

  // The routes ride the SAME http server as the hub, so a revoke over HTTP and the
  // socket it has to close are genuinely the same process.
  server = http.createServer(createTestApp({ '/api/oauth': oauthRouter, '/api/auth': authRouter }));
  wsHub.attachWsHub(server, TEST_SESSION_SECRET);
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind synchronously to a TCP port');
  }
  server.unref();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(() => {
  server.close();
  testDb.cleanup();
});

function appToken(userId: number, name = 'Socket app') {
  const app = oauth.createApp({ clientName: name, clientUri: null, redirectUris: [OOB] });
  return { app, token: oauth.createToken(app.id, userId) };
}

// Open a socket and resolve once it has received its first frame, so the server
// has definitely registered it before anything tries to close it.
function connect(bearer: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timed out waiting for the first frame'));
    }, 5000);
    ws.once('message', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket was never closed')), 5000);
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('an OAuth socket', () => {
  it('opens with an access token and gets the snapshot like any client', async () => {
    const user = createUser('oauth-ws-open');
    const ws = await connect(appToken(user.id).token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('is refused once its token is revoked', async () => {
    const user = createUser('oauth-ws-refused');
    const { app, token } = appToken(user.id);
    oauth.deleteTokenForClient(token, app.clientId);
    await expect(connect(token)).rejects.toThrow(/401/);
  });

  it('closes when the app revokes its token, leaving the web session connected', async () => {
    const user = createUser('oauth-ws-revoke');
    const { app, token } = appToken(user.id);
    const appSocket = await connect(token);
    const sessionSocket = await connect(createSession(user.id).token);
    const evicted = closed(appSocket);

    const res = await request(server)
      .post('/api/oauth/revoke')
      .type('form')
      .send({ client_id: app.clientId, token });
    expect(res.status).toBe(200);

    expect(await evicted).toBe(WS_CLOSE_SESSION_REVOKED);
    expect(sessionSocket.readyState).toBe(WebSocket.OPEN);
    sessionSocket.close();
  });

  it('closes every socket of an app revoked from Settings, and no other app’s', async () => {
    const user = createUser('oauth-ws-settings');
    const revoked = appToken(user.id, 'Revoked app');
    const kept = appToken(user.id, 'Kept app');
    const [first, second] = await Promise.all([connect(revoked.token), connect(revoked.token)]);
    const other = await connect(kept.token);
    const bothClosed = Promise.all([closed(first), closed(second)]);

    const res = await request(server)
      .delete(`/api/oauth/apps/${revoked.app.id}`)
      .set('Authorization', `Bearer ${createSession(user.id).token}`);
    expect(res.status).toBe(200);

    expect(await bothClosed).toEqual([WS_CLOSE_SESSION_REVOKED, WS_CLOSE_SESSION_REVOKED]);
    expect(other.readyState).toBe(WebSocket.OPEN);
    other.close();
  });

  it('closes when the app signs out with its token', async () => {
    const user = createUser('oauth-ws-logout');
    const { token } = appToken(user.id);
    const ws = await connect(token);
    const evicted = closed(ws);

    await request(server).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);

    expect(await evicted).toBe(WS_CLOSE_SESSION_REVOKED);
  });
});
