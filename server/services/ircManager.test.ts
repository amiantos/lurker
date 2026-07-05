// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
let listChannels: typeof import('../db/networks.js').listChannels;
let insertDccTransfer: typeof import('../db/dccTransfers.js').insertDccTransfer;
let updateDccTransferState: typeof import('../db/dccTransfers.js').updateDccTransferState;
let planChannelRejoins: typeof import('./ircManager.js').planChannelRejoins;

beforeAll(async () => {
  ircManager = (await import('./ircManager.js')).default;
  ({ planChannelRejoins } = await import('./ircManager.js'));
  connectScheduler = (await import('./connectScheduler.js')).default;
  systemLog = (await import('./systemLog.js')).default;
  ({ createUser, setUserPaused } = await import('../db/users.js'));
  ({ createNetwork, listChannels } = await import('../db/networks.js'));
  ({ insertDccTransfer, updateDccTransferState } = await import('../db/dccTransfers.js'));
});

afterAll(() => ctx.cleanup());

// Any deferrable startNetwork leaves a launch queued in the process-wide
// scheduler (and a pending timer). Drain it between tests so a staggered
// launch never fires against a torn-down connection in a later test.
afterEach(() => connectScheduler.reset());

// Poll until a condition holds, bounded by a timeout — for awaiting a scheduler
// timer to fire without betting on a fixed real-time delay (a 0ms timer can
// slip well past a hard-coded sleep under CI load).
async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

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

describe('ircManager.acceptDccTransfer result codes', () => {
  let seq = 0;
  function dccUserNet() {
    const user = createUser(`dcc-accept-${(seq += 1)}`);
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'x',
      autoconnect: false,
    });
    if (!net) throw new Error('createNetwork returned undefined');
    return { userId: user.id, networkId: net.id };
  }

  it('returns not-found for an unknown transfer id', () => {
    const { userId } = dccUserNet();
    expect(ircManager.acceptDccTransfer(userId, 999999)).toBe('not-found');
  });

  it('returns not-pending for a row that already left pending_approval', () => {
    // Copilot review: accepting a non-pending row used to no-op yet report 200.
    const { userId, networkId } = dccUserNet();
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'bot',
      filename: 'done.bin',
      advertised_size: 100,
      state: 'pending_approval',
    });
    updateDccTransferState(id, 'completed');
    expect(ircManager.acceptDccTransfer(userId, id)).toBe('not-pending');
  });

  it('returns not-connected for a genuine pending offer on a stopped network', () => {
    const { userId, networkId } = dccUserNet();
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'bot',
      filename: 'f.bin',
      advertised_size: 100,
      state: 'pending_approval',
      peer_host: '203.0.113.7',
      peer_port: 5000,
    });
    // No live connection registered → can't dial.
    expect(ircManager.acceptDccTransfer(userId, id)).toBe('not-connected');
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

describe('ircManager ignore scoping (#350)', () => {
  const igRule = (mask: string) => ({
    mask,
    channels: null,
    pattern: null,
    patternKind: 'substr' as const,
    levels: ['ALL'],
    isExcept: false,
    expiresAt: null,
  });

  it('keeps global rules out of per-network snapshot blobs and in listGlobalIgnoresFor', () => {
    const user = createUser('irc-ignore-scope');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'z',
      autoconnect: false,
    });
    if (!net) throw new Error('createNetwork returned undefined');

    ircManager.addIgnore(user.id, null, igRule('globalguy'));
    ircManager.addIgnore(user.id, net.id, igRule('netguy'));

    expect(ircManager.listGlobalIgnoresFor(user.id).map((r) => r.mask)).toEqual(['globalguy']);
    expect(ircManager.listIgnoredFor(user.id, net.id).map((r) => r.mask)).toEqual(['netguy']);

    const snap = ircManager.snapshotForUser(user.id) as Array<Record<string, unknown>>;
    const blob = snap.find((b) => b.networkId === net.id)!;
    const masks = (blob.ignoredMasks as Array<{ mask: string }>).map((m) => m.mask);
    expect(masks).toContain('netguy');
    expect(masks).not.toContain('globalguy');
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

    // Let the scheduler's queued 0ms launch fire — pump() splices the task out
    // of the queue and runs it, so the count returning to 0 means the launch
    // ran (and its guard short-circuited).
    await waitUntil(() => connectScheduler.pendingCount() === 0);

    // The launch guard short-circuited: it ran without ever logging a "Starting
    // connection" line (which only the connect path emits).
    const lines = systemLog.getRecent(user.id);
    expect(lines.some((l) => /Starting connection/.test(l.text))).toBe(false);
  });
});

// Contact CRUD goes through ircManager so it can diff watch-targets onto the
// live MONITOR set. With no live connection the diff is a no-op, so these
// assertions exercise the db orchestration, ownership scoping, and the
// per-(network,nick) uniqueness filter without opening a socket.
describe('ircManager contacts', () => {
  it('creates, edits, and lists contacts; enforces ownership + uniqueness', () => {
    const user = createUser('irc-contacts');
    const other = createUser('irc-contacts-other');
    const net = createNetwork(user.id, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'a' })!;

    const a = ircManager.setContact(user.id, {
      displayName: 'Darc',
      notifyOnline: true,
      targets: [{ networkId: net.id, nick: 'darc' }],
    });
    expect(a).toMatchObject({ displayName: 'Darc', notifyOnline: true });
    // A lone target is the primary by default.
    expect(a!.targets).toEqual([{ networkId: net.id, nick: 'darc', isPrimary: true }]);

    // A target on a network the caller doesn't own is filtered out.
    const otherNet = createNetwork(other.id, {
      name: 'x',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    const b = ircManager.setContact(user.id, {
      displayName: 'Sneaky',
      notifyOnline: false,
      targets: [
        { networkId: net.id, nick: 'sneaky' },
        { networkId: otherNet.id, nick: 'pwn' },
      ],
    });
    expect(b!.targets).toEqual([{ networkId: net.id, nick: 'sneaky', isPrimary: true }]);

    // (network, nick) already owned by contact `a` can't be claimed by another.
    const c = ircManager.setContact(user.id, {
      displayName: 'Thief',
      notifyOnline: false,
      targets: [{ networkId: net.id, nick: 'DARC' }],
    });
    expect(c!.targets).toEqual([]);

    expect(
      ircManager
        .listContacts(user.id)
        .map((x) => x.displayName)
        .toSorted(),
    ).toEqual(['Darc', 'Sneaky', 'Thief']);
    expect(ircManager.listContacts(other.id)).toEqual([]);
  });

  it('honors the flagged primary target, falling back to the first', () => {
    const user = createUser('irc-contacts-primary');
    const n1 = createNetwork(user.id, { name: 'n1', host: 'h', port: 6697, tls: true, nick: 'a' })!;
    const n2 = createNetwork(user.id, { name: 'n2', host: 'h', port: 6697, tls: true, nick: 'a' })!;

    const chosen = ircManager.setContact(user.id, {
      displayName: 'Multi',
      notifyOnline: false,
      targets: [
        { networkId: n1.id, nick: 'm1' },
        { networkId: n2.id, nick: 'm2', isPrimary: true },
      ],
    })!;
    expect(chosen.targets.find((t) => t.nick === 'm2')!.isPrimary).toBe(true);
    expect(chosen.targets.find((t) => t.nick === 'm1')!.isPrimary).toBe(false);

    // No target flagged → first becomes primary.
    const fallback = ircManager.setContact(user.id, {
      contactId: chosen.id,
      displayName: 'Multi',
      notifyOnline: false,
      targets: [
        { networkId: n1.id, nick: 'm1' },
        { networkId: n2.id, nick: 'm2' },
      ],
    })!;
    expect(fallback.targets.find((t) => t.nick === 'm1')!.isPrimary).toBe(true);
  });

  it('allows multiple nicks on the same network', () => {
    const user = createUser('irc-contacts-alts');
    const net = createNetwork(user.id, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'a' })!;
    const saved = ircManager.setContact(user.id, {
      displayName: 'Alts',
      notifyOnline: false,
      targets: [
        { networkId: net.id, nick: 'eren' },
        { networkId: net.id, nick: 'nostimo' },
        { networkId: net.id, nick: 'twomoon', isPrimary: true },
        { networkId: net.id, nick: 'eren' }, // exact dupe dropped
      ],
    })!;
    expect(saved.targets.map((t) => t.nick).toSorted()).toEqual(['eren', 'nostimo', 'twomoon']);
    expect(saved.targets.filter((t) => t.isPrimary).map((t) => t.nick)).toEqual(['twomoon']);
  });

  it('deletes a contact only for its owner', () => {
    const user = createUser('irc-contacts-del');
    const other = createUser('irc-contacts-del-other');
    const net = createNetwork(user.id, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'a' })!;
    const made = ircManager.setContact(user.id, {
      displayName: 'Gone',
      notifyOnline: false,
      targets: [{ networkId: net.id, nick: 'gone' }],
    })!;
    expect(ircManager.deleteContact(other.id, made.id)).toBe(false);
    expect(ircManager.deleteContact(user.id, made.id)).toBe(true);
    expect(ircManager.listContacts(user.id)).toEqual([]);
  });
});

describe('planChannelRejoins', () => {
  it('batches keyed channels (with an aligned key list) separately from keyless ones', () => {
    const ops = planChannelRejoins([
      { name: '#alsoplain', key: null },
      { name: '#k1', key: 'key1' },
      { name: '#plain', key: null },
      { name: '#k2', key: 'key2' },
    ]);
    // One keyed JOIN line with a positional key list, then the keyless batch —
    // keyed channels are never folded into the keyless (key-less) line.
    expect(ops).toEqual([
      { channels: '#k1,#k2', keys: 'key1,key2' },
      { channels: '#alsoplain,#plain' },
    ]);
  });

  it('keeps keys aligned 1:1 with channels within each keyed batch', () => {
    const keyed = Array.from({ length: 40 }, (_, i) => ({
      name: `#keyed-${String(i).padStart(2, '0')}`,
      key: `secret-${String(i).padStart(2, '0')}`,
    }));
    const ops = planChannelRejoins(keyed);
    expect(ops.length).toBeGreaterThan(1); // must split under the line cap
    const seen: Record<string, string> = {};
    for (const op of ops) {
      const chans = op.channels.split(',');
      const ks = (op.keys ?? '').split(',');
      expect(ks).toHaveLength(chans.length); // no misalignment across the split
      expect(op.channels.length + 1 + (op.keys ?? '').length).toBeLessThanOrEqual(400);
      chans.forEach((c, i) => (seen[c] = ks[i]));
    }
    for (const c of keyed) expect(seen[c.name]).toBe(c.key); // each kept its own key
  });

  it('splits keyless channels into multiple JOINs under the IRC line cap', () => {
    // 50 channels of 12 chars each (≈650 with separators) blow past the
    // 400-char budget → more than one batch.
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `#channel-${String(i).padStart(3, '0')}`,
      key: null as string | null,
    }));
    const ops = planChannelRejoins(many);
    expect(ops.length).toBeGreaterThan(1);
    // Every batch stays under the cap, and every channel appears exactly once.
    for (const op of ops) expect(op.channels.length).toBeLessThanOrEqual(400);
    const rejoined = ops.flatMap((o) => o.channels.split(','));
    expect(rejoined.toSorted()).toEqual(many.map((c) => c.name).toSorted());
  });

  it('returns nothing for no joined channels', () => {
    expect(planChannelRejoins([])).toEqual([]);
  });

  it('joinChannel persists the key end-to-end so the rejoin plan carries it', () => {
    const user = createUser('irc-join-e2e');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    // deferrable parks the socket launch (drained in afterEach); stub join so
    // no bytes hit the (never-opened) socket.
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true })!;
    conn.client.join = vi.fn<(channel: string, key?: string) => void>();

    ircManager.joinChannel(user.id, net.id, '#secret', 'hunter2');

    // The key made it to the DB and comes back out in the rejoin plan.
    const joined = listChannels(net.id).filter((c) => c.joined);
    expect(planChannelRejoins(joined)).toContainEqual({ channels: '#secret', keys: 'hunter2' });
  });

  it('joinChannel drops a non-string key from an untrusted payload without throwing', () => {
    const user = createUser('irc-join-badkey');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true })!;
    conn.client.join = vi.fn<(channel: string, key?: string) => void>();

    // A number sneaks in via an unvalidated ws/HTTP join payload. It must not
    // reach encryptSecret (which throws on a non-string and, on the unguarded
    // ws path, would crash the process).
    expect(() =>
      ircManager.joinChannel(user.id, net.id, '#x', 123 as unknown as string),
    ).not.toThrow();
    expect(listChannels(net.id).find((c) => c.name === '#x')!.key).toBeNull(); // dropped
    expect(conn.client.join).toHaveBeenCalledWith('#x', undefined);
  });
});
