// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A malformed WebSocket frame from a signed-in user must never take the
// process down. The dispatcher used to read `msg.type` off whatever JSON.parse
// returned, so the literal `null` threw out of the ws 'message' listener — an
// uncaughtException, which the fatal handler turns into process.exit: one frame
// from one user dropping every user's IRC. Each case here sends a bad frame,
// then proves the socket still serves by asking for a snapshot.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-malformed');

let server: http.Server;
let url: string;
let createSession: typeof import('../db/sessions.js').createSession;
let alice: number;
let networkId: number;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');
  alice = createUser('malformed-alice').id;
  // Owned but never connected: the field guards run before any dial.
  networkId = createNetwork(alice, { name: 'n', host: 'h', nick: 'alice' })!.id;

  server = http.createServer();
  attachWsHub(server, 'malformed-test-secret');
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

type Frame = Record<string, unknown>;

async function attach(
  userId: number,
  query = '',
  keepBurst = false,
): Promise<{ ws: WebSocket; heard: Frame[] }> {
  const { token } = createSession(userId);
  const ws = new WebSocket(url + query, { headers: { Authorization: `Bearer ${token}` } });
  const heard: Frame[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no backlog-complete')), 3000);
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Frame;
      heard.push(f);
      if (f.kind === 'backlog-complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  if (!keepBurst) heard.length = 0;
  return { ws, heard };
}

async function waitFor(heard: Frame[], pred: (f: Frame) => boolean): Promise<Frame> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const hit = heard.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('frame never arrived');
}

// The hub answers a 'snapshot' request with a fresh burst ending in
// backlog-complete — a reply that proves the listener survived the bad frame.
async function stillServes(ws: WebSocket, heard: Frame[]): Promise<void> {
  heard.length = 0;
  ws.send(JSON.stringify({ type: 'snapshot' }));
  await waitFor(heard, (f) => f.kind === 'backlog-complete');
}

describe('malformed frames', () => {
  for (const frame of ['null', '42', '"snapshot"', '[1,2]', 'true']) {
    it(`rejects the non-object frame ${frame} and keeps serving`, async () => {
      const { ws, heard } = await attach(alice);
      let uncaught: unknown = null;
      const trap = (err: unknown) => {
        uncaught = err;
      };
      process.prependOnceListener('uncaughtException', trap);
      try {
        ws.send(frame);
        const err = await waitFor(heard, (f) => f.kind === 'error');
        expect(err.text).toBe('invalid frame');
        await stillServes(ws, heard);
      } finally {
        process.removeListener('uncaughtException', trap);
        ws.close();
      }
      expect(uncaught).toBeNull();
    });
  }

  it('an object with no type is an unknown type, not a crash', async () => {
    const { ws, heard } = await attach(alice);
    try {
      ws.send(JSON.stringify({ networkId }));
      const err = await waitFor(heard, (f) => f.kind === 'error');
      expect(String(err.text)).toMatch(/^unknown message type/);
      await stillServes(ws, heard);
    } finally {
      ws.close();
    }
  });

  // The unknown-type error used to format `msg.type` into a template literal,
  // and the catch around the dispatcher used to String() it again: a type
  // whose toString is not callable threw in both, the second time outside any
  // protection. No coercion of the raw value anywhere now.
  it('a type whose toString throws is an unknown type, not a crash', async () => {
    const { ws, heard } = await attach(alice);
    let uncaught: unknown = null;
    const trap = (err: unknown) => {
      uncaught = err;
    };
    process.prependOnceListener('uncaughtException', trap);
    try {
      ws.send(JSON.stringify({ type: { toString: null } }));
      const err = await waitFor(heard, (f) => f.kind === 'error');
      expect(err.text).toBe('unknown message type: <object>');
      await stillServes(ws, heard);
    } finally {
      process.removeListener('uncaughtException', trap);
      ws.close();
    }
    expect(uncaught).toBeNull();
  });

  // The cases the verb registry does not type: a number where the dispatcher
  // handed a string straight to a string method. Answered like any other
  // rejection, so a client bug is visible rather than a silent no-op.
  for (const [label, frame] of [
    ['raw with a numeric line', { type: 'raw', networkId, line: 5 }],
    ['join with a numeric channel', { type: 'join', networkId, channel: 5 }],
    ['part with an object channel', { type: 'part', networkId, channel: {} }],
    ['away with an object message', { type: 'away', networkId, message: {} }],
    ['typing with a numeric target', { type: 'typing', networkId, target: 1, state: 'active' }],
  ] as const) {
    it(`refuses ${label} with an error frame and keeps serving`, async () => {
      const { ws, heard } = await attach(alice);
      let uncaught: unknown = null;
      const trap = (err: unknown) => {
        uncaught = err;
      };
      process.prependOnceListener('uncaughtException', trap);
      try {
        ws.send(JSON.stringify({ ...frame, clientId: 'c1' }));
        const err = await waitFor(heard, (f) => f.kind === 'error');
        expect(String(err.text)).toMatch(/^invalid frame: /);
        const ack = await waitFor(heard, (f) => f.kind === 'send-result');
        expect(ack).toMatchObject({ clientId: 'c1', ok: false, error: 'invalid-frame' });
        await stillServes(ws, heard);
      } finally {
        process.removeListener('uncaughtException', trap);
        ws.close();
      }
      expect(uncaught).toBeNull();
    });
  }

  // The WS `search` command is gone as of protocol version 2 (#799). A version 1
  // client that still sends it is served, and told so like any unknown type.
  it('a version 1 client sending the removed search command is told it is unknown', async () => {
    const { ws, heard } = await attach(alice, '?v=1', true);
    try {
      expect(heard.find((f) => f.kind === 'snapshot')?.protocolVersion).toBe(2);
      heard.length = 0;
      ws.send(JSON.stringify({ type: 'search', query: 'hello', token: 7 }));
      const err = await waitFor(heard, (f) => f.kind === 'error');
      expect(err.text).toBe('unknown message type: search');
      await stillServes(ws, heard);
      expect(heard.some((f) => f.kind === 'search-result')).toBe(false);
    } finally {
      ws.close();
    }
  });
});
