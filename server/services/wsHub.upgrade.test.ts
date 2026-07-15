// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// End-to-end cover for the /ws upgrade itself (#489). wsHub.test.ts exercises
// authenticateUpgrade as a function; this drives a real `ws` client against a
// real http server running attachWsHub, because the whole promise of native
// bearer auth is that an actual socket opens when the ONLY credential on the
// upgrade is an Authorization header. A function-level test cannot prove that:
// it would still pass if the header never reached the upgrade handler.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb, TEST_SESSION_SECRET } from '../test-utils/testApp.js';
import { sign as signCookie } from 'cookie-signature';

const testDb = setupTestDb('wshub-upgrade');

let server: http.Server;
let userId: number;
let createSession: typeof import('../db/sessions.js').createSession;
let url: string;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');

  userId = createUser('nativeuser').id;
  server = http.createServer();
  attachWsHub(server, TEST_SESSION_SECRET);
  // listen(0) binds synchronously with no host argument, so address() is live on
  // return (same reasoning as test-utils/testApp.ts). If it ever isn't, say so —
  // casting the null away would build a `ws://127.0.0.1:undefined/ws` URL and
  // surface a bind failure as an inscrutable connection error in every test below.
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

// Resolves to the first frame the server sends (hydration starts with
// `snapshot`), or rejects with the HTTP status when the upgrade is refused.
function connect(headers: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timed out waiting for a frame'));
    }, 5000);
    ws.on('message', (raw) => {
      clearTimeout(timer);
      ws.close();
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`upgrade refused: ${res.statusCode}`));
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('/ws upgrade', () => {
  it('opens for a native client presenting ONLY a bearer token', async () => {
    const { token } = createSession(userId);
    const frame = await connect({ Authorization: `Bearer ${token}` });
    // Getting a snapshot means the socket opened AND hydration ran for the right
    // user — the bearer resolved all the way through to a session.
    expect(frame.kind).toBe('snapshot');
  });

  it('still opens for a browser presenting the signed session cookie', async () => {
    const { token } = createSession(userId);
    const signed = encodeURIComponent('s:' + signCookie(token, TEST_SESSION_SECRET));
    const frame = await connect({ Cookie: `lurker_session=${signed}` });
    expect(frame.kind).toBe('snapshot');
  });

  it('refuses an upgrade with no credentials', async () => {
    await expect(connect({})).rejects.toThrow(/401/);
  });

  it('refuses an upgrade with an unknown bearer token', async () => {
    await expect(connect({ Authorization: 'Bearer not-a-real-token' })).rejects.toThrow(/401/);
  });
});
