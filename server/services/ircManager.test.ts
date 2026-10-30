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
let updateNetwork: typeof import('../db/networks.js').updateNetwork;
let buffers: typeof import('../db/buffers.js');
let insertDccTransfer: typeof import('../db/dccTransfers.js').insertDccTransfer;
let updateDccTransferState: typeof import('../db/dccTransfers.js').updateDccTransferState;
let planChannelRejoins: typeof import('./ircManager.js').planChannelRejoins;

beforeAll(async () => {
  ircManager = (await import('./ircManager.js')).default;
  ({ planChannelRejoins } = await import('./ircManager.js'));
  connectScheduler = (await import('./connectScheduler.js')).default;
  systemLog = (await import('./systemLog.js')).default;
  ({ createUser, setUserPaused } = await import('../db/users.js'));
  ({ createNetwork, updateNetwork } = await import('../db/networks.js'));
  buffers = await import('../db/buffers.js');
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

// #616: the gate the auto-reconnect controller now asks before each retry. Same
// implementation startNetwork uses, so the two can't drift apart — which is the
// whole point, since the reconnect path used to skip both checks entirely.
// #459. A dial refused because the network's client certificate cannot be
// presented opens no socket, so nothing ever schedules a retry — and
// startNetwork is a documented no-op when a connection object already exists.
// Leaving the refused one in the map would make /connect answer ok and do
// nothing, forever, even after the user removes the certificate.
describe('ircManager and a connection refused over its certificate', () => {
  it('drops the refused connection so a later /connect builds a working one', async () => {
    const { setNetworkClientCert } = await import('../db/networks.js');
    const user = createUser('certfp-corpse');
    const network = createNetwork(user.id, {
      name: 'certfp-corpse-net',
      host: 'irc.example.test',
      port: 6697,
      tls: true,
      nick: 'nick',
      autoconnect: false,
    })!;
    // Half a pair — what a hand-edited archive plants, and one of the reasons
    // the dial is refused outright.
    setNetworkClientCert(network.id, user.id, { cert: 'cert-only', key: '' });

    expect(ircManager.startNetwork(user.id, network.id)).not.toBe(null);
    // Refused, and gone: not a corpse the next call would hand back.
    expect(ircManager.getConnection(user.id, network.id)).toBeFalsy();

    // The user fixes it the only way the UI offers.
    setNetworkClientCert(network.id, user.id, null);
    const revived = ircManager.startNetwork(user.id, network.id);
    expect(revived).not.toBe(null);
    expect(ircManager.getConnection(user.id, network.id)).toBe(revived);
    ircManager.disposeNetwork(user.id, network.id, 'test over');
  });
});

describe('ircManager.connectGate', () => {
  let seq = 0;
  function gateUserNet(host = 'irc.example.invalid') {
    const user = createUser(`gate-${(seq += 1)}`);
    const net = createNetwork(user.id, {
      name: 'n',
      host,
      port: 6697,
      tls: true,
      nick: 'x',
      autoconnect: false,
    });
    if (!net) throw new Error('createNetwork returned undefined');
    return { userId: user.id, networkId: net.id };
  }

  // Hands back the row it read. startNetwork consumes it instead of issuing a
  // second getNetwork — a duplicate synchronous read on every connect, on the
  // boot-time fan-out path #460 showed can starve the event loop.
  it('allows an ordinary account and network, returning the row it read', () => {
    const { userId, networkId } = gateUserNet();
    const gate = ircManager.connectGate(userId, networkId);
    expect(gate.ok).toBe(true);
    expect(gate.ok === true && gate.network.id).toBe(networkId);
    expect(gate.ok === true && gate.network.host).toBe('irc.example.invalid');
  });

  // The refusal reason is user-facing: auto-reconnect publishes it when it stops,
  // and a connection that quits retrying without saying why reads as a bug.
  it('refuses a paused account with a reason', () => {
    const { userId, networkId } = gateUserNet();
    setUserPaused(userId, true);
    const gate = ircManager.connectGate(userId, networkId);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toMatch(/paused/i);
  });

  it('refuses a network that has been deleted out from under a pending retry', () => {
    const { userId, networkId } = gateUserNet();
    const gate = ircManager.connectGate(userId, networkId + 100000);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toMatch(/no longer exists/i);
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

  it('networkChanged hands the edited row to the live connection (#1193)', () => {
    const { user, net } = makeAutoconnectNetwork('edit-live');
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true });
    expect(conn).not.toBeNull();
    const edited = vi.spyOn(conn!, 'networkEdited');
    updateNetwork(net.id, user.id, { flood_protection: false });
    ircManager.networkChanged(user.id, net.id);
    expect(edited).toHaveBeenCalledTimes(1);
    expect(edited.mock.calls[0][0]).toMatchObject({ id: net.id, flood_protection: 0 });
    connectScheduler.reset();
  });

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

  it('joinChannel persists the key end-to-end (via the echo) so the rejoin plan carries it', () => {
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

    // The request persists NOTHING — the registry row (and its key) is written
    // by the join echo, the only proof the join landed where we asked.
    expect(buffers.getBuffer(user.id, net.id, '#secret')).toBeUndefined();
    conn.client.user.nick = 'a';
    conn.client.emit('join', { channel: '#secret', nick: 'a' });

    const joined = buffers
      .listAutojoinChannels(net.id)
      .map((b) => ({ name: b.target, key: b.key }));
    expect(planChannelRejoins(joined)).toContainEqual({ channels: '#secret', keys: 'hunter2' });
  });

  it("the autojoin's JOIN goes in the queue's high lane, ahead of chat (#1149)", () => {
    const user = createUser('irc-autojoin-lane');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true })!;
    conn.client.join = vi.fn<(channel: string, key?: string) => void>();
    ircManager.joinChannel(user.id, net.id, '#home');
    conn.client.user.nick = 'a';
    conn.client.emit('join', { channel: '#home', nick: 'a' }); // the echo lands
    const join = vi.spyOn(conn, 'join');
    (conn.client as unknown as { options: unknown }).options = { ping_interval: 0 };
    conn.client.emit('registered', { nick: 'a' });
    expect(join).toHaveBeenCalledWith('#home', undefined, 'high');
  });

  it('partChannel does not create a row for a channel we have none for', () => {
    // /part takes an arbitrary argument and is not gated on membership, so it
    // must not conjure a channels row for a channel we were never in.
    const user = createUser('irc-part-phantom');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true })!;
    conn.client.part = vi.fn<(channel: string, reason?: string) => void>();

    ircManager.partChannel(user.id, net.id, '#never-heard-of');

    // The network's `:server:` sentinel row (minted at network creation,
    // schema 17) is the only row — no channel was conjured.
    expect(buffers.listForNetwork(net.id).filter((b) => b.kind !== 'server')).toHaveLength(0);
    expect(conn.client.part).toHaveBeenCalledWith('#never-heard-of', undefined);
  });

  it('partChannel still clears joined on a channel we do have a row for', () => {
    const user = createUser('irc-part-clears');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true })!;
    conn.client.join = vi.fn<(channel: string, key?: string) => void>();
    conn.client.part = vi.fn<(channel: string, reason?: string) => void>();

    ircManager.joinChannel(user.id, net.id, '#real');
    conn.client.user.nick = 'a';
    conn.client.emit('join', { channel: '#real', nick: 'a' }); // the echo lands
    expect(buffers.getBuffer(user.id, net.id, '#real')?.autojoin).toBe(true);

    ircManager.partChannel(user.id, net.id, '#real');
    expect(buffers.getBuffer(user.id, net.id, '#real')?.autojoin).toBe(false);
  });

  it('joinChannel reopens a closed buffer only for a channel we are already in', () => {
    // A join we're waiting on is cleared by the channel-joined echo, so that a
    // forwarded join (470) can't un-close the buffer for a channel we'll never
    // be in. But a channel we're already in gets no echo at all, so /join on it
    // would otherwise never reopen the buffer.
    const user = createUser('irc-join-reopen');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true })!;
    conn.client.join = vi.fn<(channel: string, key?: string) => void>();

    // Not in the channel yet: the request must NOT reopen on its own.
    buffers.ensureOpen(user.id, net.id, '#pending', { kind: 'channel' });
    buffers.close(user.id, net.id, '#pending');
    ircManager.joinChannel(user.id, net.id, '#pending');
    expect(buffers.isClosed(user.id, net.id, '#pending')).toBe(true);

    // Already in it: no echo is coming, so reopen right away.
    buffers.ensureOpen(user.id, net.id, '#here', { kind: 'channel' });
    buffers.close(user.id, net.id, '#here');
    conn.upsertChannel('#here');
    ircManager.joinChannel(user.id, net.id, '#here');
    expect(buffers.isClosed(user.id, net.id, '#here')).toBe(false);
  });

  it('joinChannel on an already-joined channel writes the key directly and stashes nothing', () => {
    // No echo is coming for a channel we are already in, so a stashed key
    // would sit orphaned until some LATER keyless rejoin's echo consumed it —
    // re-applying a key that MODE -k may have since cleared.
    const user = createUser('irc-join-nostash');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true })!;
    conn.client.join = vi.fn<(channel: string, key?: string) => void>();

    conn.upsertChannel('#here');
    ircManager.joinChannel(user.id, net.id, '#here', 'direct-key');

    expect(buffers.getBuffer(user.id, net.id, '#here')!.key).toBe('direct-key');
    expect(conn.takeStashedJoinKey('#here')).toBeUndefined();
  });

  it('joinChannel sends the stored key when rejoining a parted +k channel without one (#873)', () => {
    // The Join Channel menu item, the invite toast and a bare /join send no key.
    // A part only clears autojoin, so the row still holds the key the echo stored.
    const user = createUser('irc-join-storedkey');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true })!;
    const join = vi.fn<(channel: string, key?: string) => void>();
    conn.client.join = join;
    conn.client.part = vi.fn<(channel: string, reason?: string) => void>();

    ircManager.joinChannel(user.id, net.id, '#secret', 'hunter2');
    conn.client.user.nick = 'a';
    conn.client.emit('join', { channel: '#secret', nick: 'a' });
    ircManager.partChannel(user.id, net.id, '#secret');
    conn.client.emit('part', { channel: '#secret', nick: 'a' });
    expect(conn.isChannelJoined('#secret')).toBe(false);
    expect(buffers.getBuffer(user.id, net.id, '#secret')!.key).toBe('hunter2');

    join.mockClear();
    ircManager.joinChannel(user.id, net.id, '#Secret');
    expect(join).toHaveBeenCalledWith('#Secret', 'hunter2');
    // Nothing stashed: the row already holds the key.
    expect(conn.takeStashedJoinKey('#Secret')).toBeUndefined();

    // A key the caller sends still wins.
    join.mockClear();
    ircManager.joinChannel(user.id, net.id, '#secret', 'newkey');
    expect(join).toHaveBeenCalledWith('#secret', 'newkey');
  });

  it('joinChannel joins keyless when the stored key cannot be decrypted', async () => {
    // A key stored under a rotated or unknown key-id makes decryptSecret throw,
    // and joinChannel runs on the unguarded ws path.
    const db = (await import('../db/index.js')).default;
    const user = createUser('irc-join-badstoredkey');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true })!;
    const join = vi.fn<(channel: string, key?: string) => void>();
    conn.client.join = join;

    buffers.ensureOpen(user.id, net.id, '#vault', { kind: 'channel' });
    db.prepare(
      "UPDATE buffers SET key = ? WHERE user_id = ? AND network_id = ? AND kind = 'channel'",
    ).run('lk1.deadbeef.AAAAAAAA', user.id, net.id);
    expect(() => buffers.getBuffer(user.id, net.id, '#vault')).toThrow(/secretCrypto/);

    expect(() => ircManager.joinChannel(user.id, net.id, '#vault')).not.toThrow();
    expect(join).toHaveBeenCalledWith('#vault', undefined);
  });

  it('a keyless rejoin drops the key a refused JOIN left stashed', () => {
    // A refused JOIN gets no echo, so its key stays stashed. The keyless rejoin
    // after it sends the stored key and lands; its echo must not store the
    // refused key over the one that worked.
    const user = createUser('irc-join-stalestash');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'irc.example.invalid',
      port: 6697,
      tls: true,
      nick: 'a',
    })!;
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true })!;
    const join = vi.fn<(channel: string, key?: string) => void>();
    conn.client.join = join;
    conn.client.part = vi.fn<(channel: string, reason?: string) => void>();

    ircManager.joinChannel(user.id, net.id, '#secret', 'hunter2');
    conn.client.user.nick = 'a';
    conn.client.emit('join', { channel: '#secret', nick: 'a' });
    ircManager.partChannel(user.id, net.id, '#secret');
    conn.client.emit('part', { channel: '#secret', nick: 'a' });

    ircManager.joinChannel(user.id, net.id, '#secret', 'wrong'); // refused: no echo
    ircManager.joinChannel(user.id, net.id, '#secret');
    expect(join).toHaveBeenLastCalledWith('#secret', 'hunter2');
    conn.client.emit('join', { channel: '#secret', nick: 'a' });

    expect(buffers.getBuffer(user.id, net.id, '#secret')!.key).toBe('hunter2');
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
    // The bogus key was never stashed, so the echo mints a keyless row.
    conn.client.user.nick = 'a';
    conn.client.emit('join', { channel: '#x', nick: 'a' });
    expect(buffers.getBuffer(user.id, net.id, '#x')!.key).toBeNull(); // dropped
    expect(conn.client.join).toHaveBeenCalledWith('#x', undefined);
  });
});

// #1084: a connection's DCC transfer rows reach wsHub's fan-out as their own
// frame, tagged with the connection's user, not as a synthetic IRC event.
describe('ircManager and a connection’s user frames', () => {
  it('re-emits them as user-frame, with the connection’s user', async () => {
    const { setNetworkClientCert } = await import('../db/networks.js');
    const user = createUser('user-frame');
    const network = createNetwork(user.id, {
      name: 'user-frame-net',
      host: 'irc.example.test',
      port: 6697,
      tls: true,
      nick: 'nick',
      autoconnect: false,
    })!;
    // Refused over its certificate, so no socket opens (see above).
    setNetworkClientCert(network.id, user.id, { cert: 'cert-only', key: '' });
    const conn = ircManager.startNetwork(user.id, network.id)!;
    const heard = vi.fn<(userId: number, frame: Record<string, unknown>) => void>();
    ircManager.on('user-frame', heard);
    try {
      const frame = { kind: 'dcc-transfer', transfer: { id: 7 } };
      conn.onUserFrame(frame);
      expect(heard).toHaveBeenCalledWith(user.id, frame);
    } finally {
      ircManager.off('user-frame', heard);
    }
  });
});

// Account restrictions (shared/accountRestrictions.ts): the connect gate holds
// an account to its host list, and restrictUser drops what the list no longer
// allows without touching what it does.
describe('ircManager account restrictions', () => {
  let setUserRestrictions: typeof import('../db/users.js').setUserRestrictions;

  beforeAll(async () => {
    ({ setUserRestrictions } = await import('../db/users.js'));
  });

  function netOn(userId: number, name: string, host: string) {
    const net = createNetwork(userId, { name, host, port: 6697, tls: true, nick: 'x' });
    if (!net) throw new Error('createNetwork returned undefined');
    return net;
  }

  it("startNetwork refuses a host outside the account's list", () => {
    const user = createUser('irc-held');
    const net = netOn(user.id, 'libera', 'irc.libera.chat');
    setUserRestrictions(user.id, { networks: ['irc.lurker.chat'], uploads: true });
    expect(ircManager.startNetwork(user.id, net.id)).toBeNull();
    expect(ircManager.getConnection(user.id, net.id)).toBeNull();
    expect(ircManager.connectGate(user.id, net.id)).toMatchObject({
      ok: false,
      reason: 'irc.libera.chat is not permitted for this account',
    });
  });

  it('restrictUser drops the connections the new list refuses and keeps the rest', () => {
    const user = createUser('irc-narrowed');
    const home = netOn(user.id, 'home', 'irc.lurker.chat');
    const away = netOn(user.id, 'away', 'irc.libera.chat');
    const homeConn = ircManager.startNetwork(user.id, home.id, { deferrable: true });
    const awayConn = ircManager.startNetwork(user.id, away.id, { deferrable: true });
    expect(homeConn).not.toBeNull();
    expect(awayConn).not.toBeNull();

    const events: unknown[] = [];
    const onRestricted = (e: unknown) => events.push(e);
    ircManager.on('user-restricted', onRestricted);
    try {
      const restrictions = { networks: ['irc.lurker.chat'], uploads: true };
      setUserRestrictions(user.id, restrictions);
      ircManager.restrictUser(user.id, restrictions);
      expect(ircManager.getConnection(user.id, away.id)).toBeNull();
      expect(ircManager.getConnection(user.id, home.id)).toBe(homeConn);
      expect(events).toEqual([{ userId: user.id, restrictions }]);
    } finally {
      ircManager.off('user-restricted', onRestricted);
      ircManager.disposeNetwork(user.id, home.id, 'test over');
      connectScheduler.reset();
    }
  });

  it('restrictUser with no host list drops nothing', () => {
    const user = createUser('irc-uploads-only');
    const net = netOn(user.id, 'n', 'irc.libera.chat');
    const conn = ircManager.startNetwork(user.id, net.id, { deferrable: true });
    try {
      ircManager.restrictUser(user.id, { networks: null, uploads: false });
      expect(ircManager.getConnection(user.id, net.id)).toBe(conn);
    } finally {
      ircManager.disposeNetwork(user.id, net.id, 'test over');
      connectScheduler.reset();
    }
  });
});
