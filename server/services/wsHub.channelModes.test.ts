// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The channel modal's two WS messages (#727), through a real socket. Each
// answers on the send-result ACK with the verb's whole result as `data` — and
// get-mode-list answers LATE, after the server's list has come back, so the
// ACK has to wait for the verb's promise rather than go out on the spot.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';
import { parseModeSpec } from '../../shared/channelModes.js';
import type { ModeListResult } from './modeList.js';

const testDb = setupTestDb('wshub-channelmodes');

let server: http.Server;
let userId: number;
let networkId: number;
let url: string;
let createSession: typeof import('../db/sessions.js').createSession;
let ircManager: typeof import('./ircManager.js').default;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');
  await import('./verbs/index.js');
  ircManager = (await import('./ircManager.js')).default;

  userId = createUser('channelmodesuser').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'channelmodesuser',
  })!.id;

  server = http.createServer();
  attachWsHub(server, 'channelmodes-test-secret');
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

afterEach(() => ircManager.connectionsForUser(userId).clear());

type Frame = Record<string, unknown>;

// A connected network whose list fetch answers after a delay, as a server does.
function liveNetwork(result: ModeListResult) {
  const sent: string[] = [];
  const conn = {
    state: 'connected',
    network: { id: networkId },
    raw: (line: string) => sent.push(line),
    channelState: (name: string) =>
      name.toLowerCase() === '#chan' ? { name: '#chan' } : undefined,
    modeSpec: () => parseModeSpec({ MODES: '3' }),
    fetchModeList: () =>
      new Promise<ModeListResult>((resolve) => setTimeout(() => resolve(result), 50)),
  };
  type Conn = ReturnType<typeof ircManager.listConnections>[number];
  ircManager.connectionsForUser(userId).set(networkId, conn as unknown as Conn);
  return sent;
}

// Connect, drain the opening burst, send one frame, return its send-result.
// `setup` runs after the burst: a stub connection has no snapshot() to give it.
async function ack(frame: Frame, setup: () => void = () => {}): Promise<Frame> {
  const { token } = createSession(userId);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  try {
    return await new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no send-result')), 3000);
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString()) as Frame;
        if (f.kind === 'backlog-complete') {
          setup();
          ws.send(JSON.stringify({ ...frame, clientId: 'c1' }));
        }
        if (f.kind === 'send-result' && f.clientId === 'c1') {
          clearTimeout(timer);
          resolve(f);
        }
      });
    });
  } finally {
    ws.close();
  }
}

describe('channel modal WS messages', () => {
  it("get-mode-list answers with the list once the server's reply is in", async () => {
    const entries = [{ mask: '*!*@bad', setBy: 'op', setAt: null }];
    const reply = await ack(
      { type: 'get-mode-list', networkId, channel: '#chan', letter: 'b' },
      () => liveNetwork({ ok: true, entries }),
    );
    expect(reply).toMatchObject({
      ok: true,
      data: { ok: true, channel: '#chan', letter: 'b', entries },
    });
  });

  it("get-mode-list carries the server's refusal", async () => {
    const reply = await ack(
      { type: 'get-mode-list', networkId, channel: '#chan', letter: 'e' },
      () => liveNetwork({ ok: false, error: 'refused', numeric: '482', text: 'not op' }),
    );
    expect(reply).toMatchObject({
      ok: false,
      error: 'refused',
      data: { numeric: '482', text: 'not op' },
    });
  });

  it('set-channel-modes sends the batch and says how many lines', async () => {
    let sent: string[] = [];
    const reply = await ack(
      {
        type: 'set-channel-modes',
        networkId,
        channel: '#chan',
        changes: [
          { sign: '+', letter: 'm' },
          { sign: '+', letter: 'l', param: '20' },
        ],
      },
      () => (sent = liveNetwork({ ok: true, entries: [] })),
    );
    expect(reply).toMatchObject({ ok: true, data: { ok: true, lines: 1 } });
    expect(sent).toEqual(['MODE #chan +ml 20']);
  });

  it('set-topic sets the topic through the verb, and says when it went nowhere', async () => {
    let sent: string[] = [];
    const reply = await ack(
      { type: 'set-topic', networkId, channel: '#chan', topic: 'hello there' },
      () => (sent = liveNetwork({ ok: true, entries: [] })),
    );
    expect(reply).toMatchObject({ ok: true });
    expect(sent).toEqual(['TOPIC #chan :hello there']);
    // A raw TOPIC to a down network is dropped in silence; this isn't.
    ircManager.connectionsForUser(userId).clear();
    const offline = await ack({ type: 'set-topic', networkId, channel: '#chan', topic: 'x' });
    expect(offline).toMatchObject({ ok: false, error: 'not-connected' });
  });

  it('answers not-connected when the network is down', async () => {
    const reply = await ack({ type: 'get-mode-list', networkId, channel: '#chan', letter: 'b' });
    expect(reply).toMatchObject({ ok: false, error: 'not-connected' });
  });

  it("resolves the ACK when the network isn't the caller's, like a send's", async () => {
    const reply = await ack({
      type: 'get-mode-list',
      networkId: 999999,
      channel: '#c',
      letter: 'b',
    });
    expect(reply).toMatchObject({ ok: false, error: 'unknown-network' });
  });
});
