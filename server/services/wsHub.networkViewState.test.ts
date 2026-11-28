// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// set-network-collapsed (#1432): sidebar view state, stored on the network row
// and echoed to every socket the user has open.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb, TEST_SESSION_SECRET } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-network-collapsed');

let networksDb: typeof import('../db/networks.js');
let createSession: typeof import('../db/sessions.js').createSession;
let server: http.Server;
let url: string;
let userId: number;
let otherUserId: number;
let networkId: number;
let otherNetworkId: number;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  networksDb = await import('../db/networks.js');
  ({ createSession } = await import('../db/sessions.js'));
  const { attachWsHub } = await import('./wsHub.js');

  const net = { host: 'irc.example', port: 6697, tls: true };
  userId = createUser('folder').id;
  otherUserId = createUser('stranger').id;
  networkId = networksDb.createNetwork(userId, { ...net, name: 'libera', nick: 'folder' })!.id;
  otherNetworkId = networksDb.createNetwork(otherUserId, {
    ...net,
    name: 'oftc',
    nick: 'stranger',
  })!.id;

  server = http.createServer();
  attachWsHub(server, TEST_SESSION_SECRET);
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  server.unref();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(() => {
  server.close();
  testDb.cleanup();
});

type Frame = { kind?: string; networkId?: number; collapsed?: boolean };

// A socket for `forUser`, past its connect burst, with every later frame kept.
async function connect(forUser: number) {
  const { token } = createSession(forUser);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const frames: Frame[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
  // A verb that replies, sent after `what`, proves `what` was handled.
  const barrier = async () => {
    const before = frames.filter((f) => f.kind === 'snapshot').length;
    ws.send(JSON.stringify({ type: 'snapshot' }));
    await expect
      .poll(() => frames.filter((f) => f.kind === 'snapshot').length, { timeout: 5000 })
      .toBeGreaterThan(before);
  };
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  await barrier();
  const close = () =>
    new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.close();
    });
  return { ws, frames, barrier, close };
}

const changes = (frames: Frame[]) => frames.filter((f) => f.kind === 'network-collapsed-changed');

describe('set-network-collapsed', () => {
  it('stores the flag and tells every socket the user has open', async () => {
    const a = await connect(userId);
    const b = await connect(userId);
    try {
      a.ws.send(JSON.stringify({ type: 'set-network-collapsed', networkId, collapsed: true }));
      await a.barrier();
      await b.barrier();

      const expected = [{ kind: 'network-collapsed-changed', networkId, collapsed: true }];
      expect(changes(a.frames)).toEqual(expected);
      expect(changes(b.frames)).toEqual(expected);
      expect(networksDb.getNetwork(networkId, userId)!.collapsed).toBe(1);

      a.ws.send(JSON.stringify({ type: 'set-network-collapsed', networkId, collapsed: false }));
      await a.barrier();
      expect(networksDb.getNetwork(networkId, userId)!.collapsed).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("does nothing to someone else's network", async () => {
    const a = await connect(userId);
    try {
      a.ws.send(
        JSON.stringify({
          type: 'set-network-collapsed',
          networkId: otherNetworkId,
          collapsed: true,
        }),
      );
      a.ws.send(JSON.stringify({ type: 'set-network-collapsed', networkId: 'x', collapsed: true }));
      await a.barrier();

      expect(changes(a.frames)).toEqual([]);
      expect(networksDb.getNetwork(otherNetworkId, otherUserId)!.collapsed).toBe(0);
    } finally {
      await a.close();
    }
  });
});

describe('set-network-hide-muted', () => {
  const hideChanges = (frames: Frame[]) =>
    frames.filter((f) => f.kind === 'network-hide-muted-changed');

  it('stores the flag and tells every socket the user has open', async () => {
    const a = await connect(userId);
    const b = await connect(userId);
    try {
      a.ws.send(JSON.stringify({ type: 'set-network-hide-muted', networkId, hideMuted: true }));
      await a.barrier();
      await b.barrier();

      const expected = [{ kind: 'network-hide-muted-changed', networkId, hideMuted: true }];
      expect(hideChanges(a.frames)).toEqual(expected);
      expect(hideChanges(b.frames)).toEqual(expected);
      expect(networksDb.getNetwork(networkId, userId)!.hide_muted).toBe(1);

      a.ws.send(JSON.stringify({ type: 'set-network-hide-muted', networkId, hideMuted: false }));
      await a.barrier();
      expect(networksDb.getNetwork(networkId, userId)!.hide_muted).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("does nothing to someone else's network", async () => {
    const a = await connect(userId);
    try {
      a.ws.send(
        JSON.stringify({
          type: 'set-network-hide-muted',
          networkId: otherNetworkId,
          hideMuted: true,
        }),
      );
      a.ws.send(
        JSON.stringify({ type: 'set-network-hide-muted', networkId: 'x', hideMuted: true }),
      );
      await a.barrier();

      expect(hideChanges(a.frames)).toEqual([]);
      expect(networksDb.getNetwork(otherNetworkId, otherUserId)!.hide_muted).toBe(0);
    } finally {
      await a.close();
    }
  });
});

describe('network view state', () => {
  const blob = (frames: Frame[]) => {
    const snaps = frames.filter((f) => f.kind === 'snapshot');
    const nets = (
      snaps[snaps.length - 1] as unknown as { networks: Array<Record<string, unknown>> }
    ).networks;
    return nets.find((n) => n.networkId === networkId)!;
  };

  it('ignores a frame that does not carry the value', async () => {
    const a = await connect(userId);
    try {
      a.ws.send(JSON.stringify({ type: 'set-network-collapsed', networkId, collapsed: true }));
      a.ws.send(JSON.stringify({ type: 'set-network-hide-muted', networkId, hideMuted: true }));
      await a.barrier();
      a.ws.send(JSON.stringify({ type: 'set-network-collapsed', networkId }));
      a.ws.send(JSON.stringify({ type: 'set-network-hide-muted', networkId, hideMuted: 'false' }));
      await a.barrier();

      const row = networksDb.getNetwork(networkId, userId)!;
      expect([row.collapsed, row.hide_muted]).toEqual([1, 1]);
    } finally {
      await a.close();
    }
  });

  it('rides the snapshot, for a client that was away for the change', async () => {
    networksDb.setNetworkCollapsed(networkId, userId, true);
    networksDb.setNetworkHideMuted(networkId, userId, false);
    const a = await connect(userId);
    try {
      expect(blob(a.frames)).toMatchObject({ collapsed: true, hideMuted: false });
      networksDb.setNetworkCollapsed(networkId, userId, false);
      networksDb.setNetworkHideMuted(networkId, userId, true);
      await a.barrier();
      expect(blob(a.frames)).toMatchObject({ collapsed: false, hideMuted: true });
    } finally {
      await a.close();
    }
  });
});
