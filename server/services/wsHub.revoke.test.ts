// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Cover for closeSocketsForUser (#855). Drives a REAL socket against a real
// attachWsHub, because the property being claimed is that an already-open
// connection actually goes away: the socket authenticated at upgrade and holds
// its user in its own closure, so nothing about deleting session rows can be
// observed from inside the hub. A function-level assertion would pass even if
// the socket kept streaming, which is the exact failure it exists to rule out.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createTestApp, setupTestDb, TEST_SESSION_SECRET } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-revoke');

let server: http.Server;
let url: string;
let createUser: typeof import('../db/users.js').createUser;
let createSession: typeof import('../db/sessions.js').createSession;
let closeSocketsForUser: typeof import('./wsHub.js').closeSocketsForUser;
let createRecoveryToken: typeof import('../db/accountRecovery.js').createRecoveryToken;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createSession } = await import('../db/sessions.js'));
  ({ createRecoveryToken } = await import('../db/accountRecovery.js'));
  const wsHub = await import('./wsHub.js');
  closeSocketsForUser = wsHub.closeSocketsForUser;

  // The auth router rides the SAME http server as the hub, so redeeming a link
  // over HTTP and the socket it has to evict are genuinely the same process —
  // which is the only way to prove the route is wired to the eviction at all.
  const authRouter = (await import('../routes/auth.js')).default;
  server = http.createServer(createTestApp({ '/api/auth': authRouter }));
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

// Open a socket and resolve once it has received its first frame, so the server
// has definitely registered it before the test tries to close it.
function connect(userId: number): Promise<WebSocket> {
  const { token } = createSession(userId);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
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

describe('closeSocketsForUser', () => {
  it('closes every open socket for the account', async () => {
    const user = createUser('revoke-target');
    const [a, b] = await Promise.all([connect(user.id), connect(user.id)]);
    const bothClosed = Promise.all([closed(a), closed(b)]);
    expect(closeSocketsForUser(user.id, 'account recovered')).toBe(2);
    expect(await bothClosed).toEqual([1000, 1000]);
  });

  it('leaves other accounts connected', async () => {
    const mine = createUser('revoke-mine');
    const theirs = createUser('revoke-theirs');
    const ours = await connect(mine.id);
    const bystander = await connect(theirs.id);
    const mineClosed = closed(ours);
    closeSocketsForUser(mine.id);
    await mineClosed;
    expect(bystander.readyState).toBe(WebSocket.OPEN);
    bystander.close();
  });

  it('is a no-op for an account with nothing open', () => {
    const user = createUser('revoke-nothing-open');
    expect(closeSocketsForUser(user.id)).toBe(0);
  });
});

describe('account recovery evicts live sockets', () => {
  it('closes the attacker socket when the member redeems their link', async () => {
    // The scenario the feature is FOR: someone else holds the account with an
    // open connection. Dropping session rows alone would leave them reading
    // backlog and sending as the member for as long as they cared to stay
    // connected, because a socket is only ever checked at upgrade.
    const user = createUser('revoke-via-route');
    const attacker = await connect(user.id);
    const evicted = closed(attacker);
    const { token } = createRecoveryToken(user.id, null);

    const res = await request(server)
      .post(`/api/auth/recovery/${token}/password`)
      .send({ password: 'themembersnewpassword' });
    expect(res.status).toBe(200);

    expect(await evicted).toBe(1000);
  });
});
