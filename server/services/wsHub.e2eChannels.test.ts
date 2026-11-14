// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which channels are end-to-end encrypted reaches every client (#422): the
// snapshot carries each network's list as `e2eChannels`, and a change to it
// goes out as an `e2e-channels-changed` frame holding the whole list.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-e2e-channels');

let server: http.Server;
let url: string;
let createSession: typeof import('../db/sessions.js').createSession;
let e2eManager: typeof import('./e2e/manager.js').e2eManager;
let alice: number;
let bob: number;
let networkId: number;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ createSession } = await import('../db/sessions.js'));
  ({ e2eManager } = await import('./e2e/manager.js'));
  const { attachWsHub } = await import('./wsHub.js');
  alice = createUser('e2e-ch-alice').id;
  bob = createUser('e2e-ch-bob').id;
  networkId = createNetwork(alice, { name: 'n', host: 'h', nick: 'alice' })!.id;
  createNetwork(bob, { name: 'n', host: 'h', nick: 'bob' });
  e2eManager.setChannelConfig(alice, networkId, '#secret', true, 'normal');
  e2eManager.setChannelConfig(alice, networkId, '#was', false, 'normal');
  // A PM context: a config row that names no buffer.
  e2eManager.setChannelConfig(alice, networkId, '@~carol@c.host', true, 'normal');

  server = http.createServer();
  attachWsHub(server, 'e2e-channels-test-secret');
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

async function attach(userId: number): Promise<{ ws: WebSocket; heard: Frame[] }> {
  const { token } = createSession(userId);
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
  return { ws, heard };
}

async function until(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

const changes = (heard: Frame[]) => heard.filter((f) => f.kind === 'e2e-channels-changed');

describe('E2E-enabled channels on the wire', () => {
  it('the snapshot lists the enabled channels, and only channels', async () => {
    const { ws, heard } = await attach(alice);
    ws.close();
    const snapshot = heard.find((f) => f.kind === 'snapshot') as { networks: Frame[] };
    const net = snapshot.networks.find((n) => n.networkId === networkId)!;
    expect(net.e2eChannels).toEqual(['#secret']);
  });

  it('a toggle sends the whole list to that user alone', async () => {
    const a = await attach(alice);
    const b = await attach(bob);
    try {
      e2eManager.setChannelConfig(alice, networkId, '#new', true, 'normal');
      await until(() => changes(a.heard).length === 1);
      expect(changes(a.heard)[0]).toEqual({
        kind: 'e2e-channels-changed',
        networkId,
        channels: ['#new', '#secret'],
      });

      e2eManager.setChannelConfig(alice, networkId, '#new', false, 'normal');
      await until(() => changes(a.heard).length === 2);
      expect(changes(a.heard)[1].channels).toEqual(['#secret']);
      expect(changes(b.heard)).toEqual([]);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });

  it('a keyring import sends the list it left', async () => {
    e2eManager.setChannelConfig(alice, networkId, '#kept', true, 'normal');
    // An identity is what makes a keyring exportable.
    e2eManager.buildKeyReq(alice, networkId, '#kept');
    const exported = e2eManager.exportKeyring(alice, networkId);
    if (!exported.ok) throw new Error(exported.reason);
    e2eManager.setChannelConfig(alice, networkId, '#kept', false, 'normal');

    const { ws, heard } = await attach(alice);
    try {
      expect(e2eManager.importKeyring(alice, networkId, exported.json).ok).toBe(true);
      await until(() => changes(heard).length === 1);
      expect(changes(heard)[0].channels).toEqual(['#kept', '#secret']);
    } finally {
      ws.close();
    }
  });
});
