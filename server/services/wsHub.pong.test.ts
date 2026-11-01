// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A heartbeat pong keeps `users.last_seen_at` current, through a real socket.
//
// The column is what the hosted control plane reads to judge a tenant idle
// (routes/node.ts, GET /api/node/users/activity). Every authenticated HTTP
// request and every upgrade touch it, but a client that only listens makes
// neither for as long as its socket stays up — the pong it answers every
// heartbeat with is its one sign of life, so the pong has to count.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-pong');

let server: http.Server;
let userId: number;
let url: string;
let createSession: typeof import('../db/sessions.js').createSession;
let db: typeof import('../db/index.js').default;

const lastSeen = (): string | null =>
  (
    db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(userId) as {
      last_seen_at: string | null;
    }
  ).last_seen_at;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ createSession } = await import('../db/sessions.js'));
  db = (await import('../db/index.js')).default;
  const { attachWsHub } = await import('./wsHub.js');

  userId = createUser('ponguser').id;

  server = http.createServer();
  attachWsHub(server, 'pong-test-secret');
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

async function connect(): Promise<WebSocket> {
  const { token } = createSession(userId);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no backlog-complete')), 3000);
    ws.on('message', (raw) => {
      if ((JSON.parse(raw.toString()) as { kind?: string }).kind === 'backlog-complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return ws;
}

async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('a heartbeat pong', () => {
  it('refreshes last_seen_at for a client that only listens', async () => {
    const ws = await connect();
    // The upgrade touched the row; age it past the write throttle so the next
    // touch is visible, and so the value can only have come from the pong.
    const stale = '2000-01-01 00:00:00';
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(stale, userId);
    expect(lastSeen()).toBe(stale);

    ws.pong();
    await until(() => lastSeen() !== stale, 'the pong to touch last_seen_at');

    const seenMs = Date.parse(lastSeen()!.replace(' ', 'T') + 'Z');
    expect(Date.now() - seenMs).toBeLessThan(5_000);
    ws.close();
  });
});
