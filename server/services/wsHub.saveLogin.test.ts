// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// `/save` on the wire (#1412): the `save-login` frame asks the network's
// connection to keep the login it offered, with the buffer it was typed in, and
// a save is announced like any other network edit. What the connection does
// with it is servicesLogin.test.ts.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-save-login');

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
  const { attachWsHub } = await import('./wsHub.js');
  alice = createUser('save-login-alice').id;
  networkId = createNetwork(alice, { name: 'n', host: 'h', nick: 'alice' })!.id;

  server = http.createServer();
  attachWsHub(server, 'save-login-test-secret');
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

const changed: unknown[] = [];
const onChanged = (e: unknown) => changed.push(e);

afterEach(() => {
  ircManager.connectionsForUser(alice).clear();
  ircManager.off('network-changed', onChanged);
  changed.length = 0;
});

/** A connection with no socket, holding an offer or not. */
function stubConnection(hasOffer: boolean) {
  const asked: unknown[] = [];
  const conn = {
    state: 'connected',
    network: { id: networkId },
    networkEdited: () => {},
    saveLoginOffer: (where?: string) => {
      asked.push(where);
      return hasOffer;
    },
  };
  type Conn = ReturnType<typeof ircManager.listConnections>[number];
  ircManager.connectionsForUser(alice).set(networkId, conn as unknown as Conn);
  return asked;
}

async function attach(): Promise<WebSocket> {
  const { token } = createSession(alice);
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

/** The hub handles a frame on its own tick; wait for the side effect it must have. */
async function until(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

describe('the save-login frame', () => {
  it('saves the offer where it was typed, and announces the network edit', async () => {
    // Attached first: the welcome snapshot reads every live connection, and
    // this stub has only what the frame touches.
    const ws = await attach();
    const asked = stubConnection(true);
    ircManager.on('network-changed', onChanged);
    try {
      ws.send(JSON.stringify({ type: 'save-login', networkId, issuingTarget: '#room' }));
      await until(() => changed.length > 0);
    } finally {
      ws.close();
    }
    expect(asked).toEqual(['#room']);
    expect(changed).toEqual([{ userId: alice, networkId }]);
  });

  it('announces nothing when there was nothing to save', async () => {
    const ws = await attach();
    const asked = stubConnection(false);
    ircManager.on('network-changed', onChanged);
    try {
      ws.send(JSON.stringify({ type: 'save-login', networkId, issuingTarget: 7 }));
      await until(() => asked.length > 0);
      // A frame for a network with no connection is simply dropped.
      ws.send(JSON.stringify({ type: 'save-login', networkId: networkId + 99 }));
      ws.send(JSON.stringify({ type: 'save-login', networkId, issuingTarget: '#room' }));
      await until(() => asked.length === 2);
    } finally {
      ws.close();
    }
    expect(asked).toEqual([undefined, '#room']);
    expect(changed).toEqual([]);
  });
});
