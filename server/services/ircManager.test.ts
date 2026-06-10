// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

// The startNetwork gate is the linchpin of the pause feature: a paused account
// can never construct an IrcConnection, so every downstream send/join/action
// no-ops for free. We can assert the paused path without opening a socket
// because it returns before connect() is ever reached.
const ctx = setupTestDb('services-ircmanager');

let ircManager: typeof import('./ircManager.js').default;
let connectScheduler: typeof import('./connectScheduler.js').default;
let systemLog: typeof import('./systemLog.js').default;
let createUser: typeof import('../db/users.js').createUser;
let setUserPaused: typeof import('../db/users.js').setUserPaused;
let createNetwork: typeof import('../db/networks.js').createNetwork;

beforeAll(async () => {
  ircManager = (await import('./ircManager.js')).default;
  connectScheduler = (await import('./connectScheduler.js')).default;
  systemLog = (await import('./systemLog.js')).default;
  ({ createUser, setUserPaused } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
});

afterAll(() => ctx.cleanup());

// Any deferrable startNetwork leaves a launch queued in the process-wide
// scheduler (and a pending timer). Drain it between tests so a staggered
// launch never fires against a torn-down connection in a later test.
afterEach(() => connectScheduler.reset());

describe('ircManager pause linchpin', () => {
  it('startNetwork refuses a paused user and creates no connection', () => {
    const user = createUser('irc-paused');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'x',
      autoconnect: false,
    });
    if (!net) throw new Error('createNetwork returned undefined');

    setUserPaused(user.id, true);

    expect(ircManager.startNetwork(user.id, net.id)).toBeNull();
    expect(ircManager.getConnection(user.id, net.id)).toBeNull();
  });
});

describe('ircManager.snapshotForUser offline networks', () => {
  it('returns a disconnected blob for a network with no live connection', () => {
    const user = createUser('snap-offline');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'zoe',
      autoconnect: false,
    });
    if (!net) throw new Error('createNetwork returned undefined');

    const snap = ircManager.snapshotForUser(user.id) as Array<Record<string, unknown>>;
    expect(snap).toHaveLength(1);
    expect(snap[0].networkId).toBe(net.id);
    expect(snap[0].state).toBe('disconnected');
    expect(snap[0].nick).toBe('zoe');
    expect(snap[0].channels).toEqual([]);
  });

  it('still snapshots a paused user’s networks so their buffers stay readable', () => {
    const user = createUser('snap-paused');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'p',
      autoconnect: false,
    });
    if (!net) throw new Error('createNetwork returned undefined');
    setUserPaused(user.id, true);

    // The pause gate forbids a connection, yet the snapshot must not be empty —
    // otherwise the "you can read your history" banner has nothing to show.
    const snap = ircManager.snapshotForUser(user.id) as Array<Record<string, unknown>>;
    expect(snap).toHaveLength(1);
    expect(snap[0].networkId).toBe(net.id);
    expect(snap[0].state).toBe('disconnected');
  });
});

describe('ircManager deferrable connect (issue #236 throttle seam)', () => {
  function makeAutoconnectNetwork(handle: string) {
    const user = createUser(handle);
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'x',
      autoconnect: true,
    });
    if (!net) throw new Error('createNetwork returned undefined');
    return { user, net };
  }

  it('deferrable startNetwork enqueues the connect instead of opening a socket synchronously', () => {
    const { user, net } = makeAutoconnectNetwork('defer-enqueue');

    const before = connectScheduler.pendingCount();
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true });

    // The connection object exists and is registered in the manager, but the
    // socket-opening launch is queued in the scheduler — not run inline. (The
    // afterEach reset() cancels the pending timer, so no socket ever opens.)
    expect(conn).not.toBeNull();
    expect(ircManager.getConnection(user.id, net.id)).toBe(conn);
    expect(connectScheduler.pendingCount()).toBe(before + 1);

    // Cancel the queued 0ms launch synchronously, before the timer macrotask can
    // fire — so this test never opens a real socket to irc.example.invalid.
    connectScheduler.reset();
    expect(connectScheduler.pendingCount()).toBe(0);
  });

  it('a queued launch is skipped when its connection was disposed before its slot fired', async () => {
    const { user, net } = makeAutoconnectNetwork('defer-disposed');

    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true });
    expect(conn).not.toBeNull();

    // Tear the connection down while it still sits in the scheduler queue. The
    // default singleton fires the first per-host launch on a 0ms timer, so we
    // dispose first, then let that timer run.
    ircManager.disposeNetwork(user.id, net.id);
    expect(conn!.disposed).toBe(true);
    expect(ircManager.getConnection(user.id, net.id)).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5));

    // The launch guard short-circuited: the queue drained without ever logging
    // a "Starting connection" line (which only the connect path emits) and
    // nothing is left pending.
    expect(connectScheduler.pendingCount()).toBe(0);
    const lines = systemLog.getRecent(user.id);
    expect(lines.some((l) => /Starting connection/.test(l.text))).toBe(false);
  });
});
