// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A heartbeat pong keeps `users.last_seen_at` current — and only the pong that
// answers our ping does.
//
// The column is what the hosted control plane reads to judge a tenant idle
// (routes/node.ts, GET /api/node/users/activity). Every authenticated request
// and every upgrade touch it, but a client that only listens makes neither for
// as long as its socket stays up — the pong it answers every heartbeat with is
// its one sign of life, so that pong has to count. A pong nobody asked for must
// NOT: any client can send them at will, outside the inbound rate limit, and a
// touch is a synchronous statement on the shared connection even when the SQL
// throttle changes nothing.

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
let noteHeartbeatPong: typeof import('./wsHub.js').noteHeartbeatPong;
type Socket = Parameters<typeof noteHeartbeatPong>[0];

const STALE = '2000-01-01 00:00:00';
const lastSeen = (): string | null =>
  (
    db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(userId) as {
      last_seen_at: string | null;
    }
  ).last_seen_at;
const makeStale = () =>
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(STALE, userId);

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ createSession } = await import('../db/sessions.js'));
  db = (await import('../db/index.js')).default;
  const hub = await import('./wsHub.js');
  noteHeartbeatPong = hub.noteHeartbeatPong;

  userId = createUser('ponguser').id;

  server = http.createServer();
  hub.attachWsHub(server, 'pong-test-secret');
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

describe('a heartbeat pong', () => {
  it('that answers our ping refreshes last_seen_at for a client that only listens', () => {
    // The sweep marks a socket isAlive=false as it pings it; the pong that
    // comes back finds it so.
    makeStale();
    const ws = { isAlive: false } as Socket;
    noteHeartbeatPong(ws, userId);
    expect(ws.isAlive).toBe(true);
    const seenMs = Date.parse(lastSeen()!.replace(' ', 'T') + 'Z');
    expect(Date.now() - seenMs).toBeLessThan(5_000);
  });

  it('nobody asked for does no DB work, however many arrive', () => {
    makeStale();
    const ws = { isAlive: true } as Socket;
    for (let i = 0; i < 10_000; i += 1) noteHeartbeatPong(ws, userId);
    expect(lastSeen()).toBe(STALE);
  });

  it('through a real socket: unsolicited pongs leave the row alone', async () => {
    const ws = await connect();
    // The upgrade touched the row and left the socket alive; nothing has pinged
    // it since, so these answer no ping of ours.
    makeStale();
    for (let i = 0; i < 200; i += 1) ws.pong();
    // Let the frames land before looking: the server reads them in order, so a
    // round trip on the same socket bounds when the last one was handled.
    await new Promise<void>((resolve) => {
      ws.once('pong', () => resolve());
      ws.ping();
    });
    expect(lastSeen()).toBe(STALE);
    ws.close();
  });
});
