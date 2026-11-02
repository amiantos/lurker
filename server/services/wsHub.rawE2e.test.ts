// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// `/quote PRIVMSG #secret :…` from the web composer goes to the socket through
// wsHub's 'raw' verb, not through ircManager.send — so nothing encrypted it and
// nothing echoed it (#1116). The hub asks the same guard the MCP send_raw verb
// does, and tells the user in the channel instead of writing cleartext.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-raw-e2e');

let server: http.Server;
let url: string;
let createSession: typeof import('../db/sessions.js').createSession;
let ircManager: typeof import('./ircManager.js').default;
let alice: number;
let networkId: number;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ createSession } = await import('../db/sessions.js'));
  ircManager = (await import('./ircManager.js')).default;
  const { e2eManager } = await import('./e2e/manager.js');
  const { attachWsHub } = await import('./wsHub.js');
  alice = createUser('raw-e2e-alice').id;
  networkId = createNetwork(alice, { name: 'n', host: 'h', nick: 'alice' })!.id;
  e2eManager.setChannelConfig(alice, networkId, '#secret', true, 'normal');

  server = http.createServer();
  attachWsHub(server, 'raw-e2e-test-secret');
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

afterEach(() => ircManager.connectionsForUser(alice).clear());

type Frame = Record<string, unknown>;

/** A connection with no socket: what the hub hands the line to is all that matters. */
function stubConnection() {
  const sent: string[] = [];
  const published: Frame[] = [];
  const conn = {
    state: 'connected',
    network: { id: networkId },
    raw: (line: string) => sent.push(line),
    publishEphemeral: (event: Frame) => published.push(event),
  };
  type Conn = ReturnType<typeof ircManager.listConnections>[number];
  ircManager.connectionsForUser(alice).set(networkId, conn as unknown as Conn);
  return { sent, published };
}

async function attach(): Promise<{ ws: WebSocket; heard: Frame[] }> {
  const { token } = createSession(alice);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
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
  heard.length = 0;
  return { ws, heard };
}

/** The hub handles a frame on its own tick; wait for the side effect it must have. */
async function until(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

describe("the web client's raw line on an E2E channel", () => {
  it('refuses a cleartext PRIVMSG and says so in the channel', async () => {
    // Attached first: the welcome snapshot reads every live connection, and
    // this stub has only what the raw verb touches.
    const { ws } = await attach();
    const { sent, published } = stubConnection();
    try {
      ws.send(
        JSON.stringify({ type: 'raw', networkId, line: '@+draft/reply=x PRIVMSG #Secret :plain' }),
      );
      await until(() => published.length > 0);
    } finally {
      ws.close();
    }
    expect(sent).toEqual([]);
    expect(published).toEqual([
      expect.objectContaining({ type: 'e2e', level: 'warn', target: '#secret' }),
    ]);
  });

  it('still passes every other raw line through', async () => {
    // Attached first: the welcome snapshot reads every live connection, and
    // this stub has only what the raw verb touches.
    const { ws } = await attach();
    const { sent, published } = stubConnection();
    try {
      ws.send(JSON.stringify({ type: 'raw', networkId, line: 'MODE #secret +o bob' }));
      ws.send(JSON.stringify({ type: 'raw', networkId, line: 'PRIVMSG #open :plain' }));
      await until(() => sent.length === 2);
    } finally {
      ws.close();
    }
    expect(sent).toEqual(['MODE #secret +o bob', 'PRIVMSG #open :plain']);
    expect(published).toEqual([]);
  });
});
