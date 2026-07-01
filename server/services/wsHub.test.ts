// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

// setupTestDb sets DATABASE_PATH before any dynamic import touches db/index.js,
// so it must run at module top level.
const testDb = setupTestDb('wshub');

let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let closeBuffer: typeof import('../db/closedBuffers.js').closeBuffer;
let reopenBuffer: typeof import('../db/closedBuffers.js').reopenBuffer;
let isClosed: typeof import('../db/closedBuffers.js').isClosed;
let setClearedState: typeof import('../db/bufferReads.js').setClearedState;
let setReadState: typeof import('../db/bufferReads.js').setReadState;
let computeTotalHighlights: typeof import('./wsHub.js').computeTotalHighlights;
let buildBufferBacklog: typeof import('./wsHub.js').buildBufferBacklog;
let buildResumeSlice: typeof import('./wsHub.js').buildResumeSlice;
let buildOfflineBacklogFrames: typeof import('./wsHub.js').buildOfflineBacklogFrames;
let handleOpenBuffer: typeof import('./wsHub.js').handleOpenBuffer;
let sweepWsHeartbeat: typeof import('./wsHub.js').sweepWsHeartbeat;
let buildSystemBacklog: typeof import('./wsHub.js').buildSystemBacklog;
let systemLineToEvent: typeof import('./wsHub.js').systemLineToEvent;
let buildSystemHistoryReply: typeof import('./wsHub.js').buildSystemHistoryReply;
let startChanlistRefresh: typeof import('./wsHub.js').startChanlistRefresh;
let DM_ELIGIBLE_TYPES: typeof import('./wsHub.js').DM_ELIGIBLE_TYPES;
let chanlist: typeof import('../db/chanlist.js');
let systemMessages: typeof import('../db/systemMessages.js').default;

let userId: number;
let networkId: number;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  ({ closeBuffer, reopenBuffer, isClosed } = await import('../db/closedBuffers.js'));
  ({ setClearedState, setReadState } = await import('../db/bufferReads.js'));
  ({
    computeTotalHighlights,
    buildBufferBacklog,
    buildResumeSlice,
    buildOfflineBacklogFrames,
    handleOpenBuffer,
    sweepWsHeartbeat,
    buildSystemBacklog,
    systemLineToEvent,
    buildSystemHistoryReply,
    startChanlistRefresh,
    DM_ELIGIBLE_TYPES,
  } = await import('./wsHub.js'));
  chanlist = await import('../db/chanlist.js');
  systemMessages = (await import('../db/systemMessages.js')).default;

  userId = createUser('alice').id;
  const net = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'alice',
  });
  networkId = net!.id;
});

afterAll(() => testDb.cleanup());

function seed(target: string, text: string): number {
  return Number(
    insertMessage({
      networkId,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text,
      self: false,
    }).id,
  );
}

// A WebSocket stand-in that records the frames send() writes. send() gates on
// `readyState === OPEN`, so the two must match for a frame to be captured.
function mockWs() {
  const frames: Array<Record<string, unknown>> = [];
  const ws = { OPEN: 1, readyState: 1, send: (s: string) => frames.push(JSON.parse(s)) };
  return { ws: ws as unknown as Parameters<typeof handleOpenBuffer>[0], frames };
}

describe('buildBufferBacklog', () => {
  it('builds a backlog frame from a buffer’s persisted history', () => {
    seed('#bl', 'one');
    seed('#bl', 'two');
    seed('#bl', 'three');
    const frame = buildBufferBacklog(userId, networkId, '#bl');
    expect(frame.kind).toBe('backlog');
    expect(frame.networkId).toBe(networkId);
    expect(frame.target).toBe('#bl');
    expect((frame.events as unknown[]).length).toBe(3);
    // No live IRC connection in the test → the channel reads as parted.
    expect(frame.joined).toBe(false);
    expect(frame.unread).toBe(3);
    expect(frame.highlights).toBe(0);
  });

  it('reports a non-channel buffer (DM) as joined', () => {
    seed('carol', 'hi');
    expect(buildBufferBacklog(userId, networkId, 'carol').joined).toBe(true);
  });

  it('counts every unread DM line as a highlight (yellow row treatment, like the system buffer)', () => {
    seed('erin', 'one');
    seed('erin', 'two');
    const frame = buildBufferBacklog(userId, networkId, 'erin');
    // No highlight rule matched these lines, yet a DM still reports highlights
    // == unread so the buffer-list row lights up yellow with the ● badge.
    expect(frame.unread).toBe(2);
    expect(frame.highlights).toBe(2);
  });

  it('omits clear-state by default (no marker)', () => {
    seed('#noclear', 'just a message');
    const frame = buildBufferBacklog(userId, networkId, '#noclear');
    expect(frame.clearedBeforeId).toBe(0);
    expect(frame.clearedAt).toBeNull();
  });

  it('ships the /clear marker in the backlog so the client can restore the filter after a reconnect', () => {
    seed('#clear', 'one');
    seed('#clear', 'two');
    const beforeFrame = buildBufferBacklog(userId, networkId, '#clear');
    const boundary = (beforeFrame.events as Array<{ id: number }>).at(-1)!.id;
    const ts = '2026-05-27T12:00:00.000Z';
    setClearedState(userId, networkId, '#clear', boundary, ts);

    const frame = buildBufferBacklog(userId, networkId, '#clear');
    expect(frame.clearedBeforeId).toBe(boundary);
    expect(frame.clearedAt).toBe(ts);
  });
});

describe('buildResumeSlice', () => {
  // Mirrors the server-side constants in wsHub.ts. If those change, these move.
  const RESUME_GAP_CAP = 500;
  const RESUME_LATEST_LIMIT = 200;

  it('ships just the missed gap and does not reset when it fits the cap', () => {
    const since = seed('#resumeSmall', 'm0');
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) ids.push(seed('#resumeSmall', `m${i}`));
    const slice = buildResumeSlice(userId, networkId, '#resumeSmall', since);
    expect(slice.reset).toBe(false);
    expect(slice.events.length).toBe(5);
    // The gap, oldest-first — exactly the rows after the cursor.
    expect((slice.events[0] as { id: number }).id).toBe(ids[0]);
    expect((slice.events.at(-1) as { id: number }).id).toBe(ids.at(-1));
    // A non-reset frame doesn't drive hasMoreOlder (the client keeps its own).
    expect(slice.hasMoreOlder).toBe(false);
  });

  it('resets to the latest slice when the gap overflows the cap (issue #205)', () => {
    const since = seed('#resumeBig', 'm0');
    let lastId = since;
    // One more than the cap so the gap is provably truncated.
    for (let i = 1; i <= RESUME_GAP_CAP + 10; i++) lastId = seed('#resumeBig', `m${i}`);
    const slice = buildResumeSlice(userId, networkId, '#resumeBig', since);
    expect(slice.reset).toBe(true);
    // Latest contiguous slice, NOT the oldest-after-cursor rows.
    expect(slice.events.length).toBe(RESUME_LATEST_LIMIT);
    expect((slice.events.at(-1) as { id: number }).id).toBe(lastId);
    // There's older history beyond the latest slice — the client can page up.
    expect(slice.hasMoreOlder).toBe(true);
  });

  it('ships the latest slice without reset on first connect (sinceId=0)', () => {
    seed('#resumeFresh', 'a');
    seed('#resumeFresh', 'b');
    const slice = buildResumeSlice(userId, networkId, '#resumeFresh', 0);
    expect(slice.reset).toBe(false);
    expect(slice.events.length).toBe(2);
  });
});

describe('buildOfflineBacklogFrames', () => {
  // Tests run with no live IRC connection, so every network is "offline" — the
  // exact case a paused/disconnected user hits. Each test uses a fresh network
  // so it doesn't depend on history seeded by sibling tests.
  it('ships offline channel/DM buffers as lazy-load shells; the server buffer stays real', () => {
    const net = createNetwork(userId, {
      name: 'offnet',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'alice',
    });
    const offId = net!.id;
    const seedOff = (target: string, text: string): void => {
      insertMessage({
        networkId: offId,
        target,
        time: new Date().toISOString(),
        type: 'message',
        nick: 'bob',
        text,
        self: false,
      });
    };
    seedOff('#offline', 'a');
    seedOff('#offline', 'b');
    seedOff('dave', 'dm');
    seedOff(`:server:${offId}`, 'server notice');

    const byTarget = new Map(
      buildOfflineBacklogFrames(userId)
        .filter((f) => f.networkId === offId)
        .map((f) => [f.target as string, f]),
    );

    // Channel ships as a SHELL: no message rows, no input history, but marked
    // hasMoreOlder so the client hydrates it on open — and the unread badge is
    // still correct (both seeded lines are unread) without touching the body.
    const chan = byTarget.get('#offline')!;
    expect(chan.kind).toBe('backlog');
    expect((chan.events as unknown[]).length).toBe(0);
    expect(chan.hasMoreOlder).toBe(true);
    expect(chan.unread).toBe(2);
    expect((chan.inputHistory as unknown[]).length).toBe(0);
    // Channels are parted (no live connection tracks them).
    expect(chan.joined).toBe(false);

    // DM buffers are shells too, but have no join concept → reported joined.
    const dm = byTarget.get('dave')!;
    expect((dm.events as unknown[]).length).toBe(0);
    expect(dm.hasMoreOlder).toBe(true);
    expect(dm.joined).toBe(true);

    // The server pseudo-buffer is NOT shelled: it ships its real recent slice so
    // the disconnect reason is visible without opening it.
    const server = byTarget.get(`:server:${offId}`)!;
    expect((server.events as unknown[]).length).toBe(1);
  });

  it('skips a closed buffer but never the server pseudo-buffer', () => {
    const net = createNetwork(userId, {
      name: 'offnet2',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'alice',
    });
    const offId = net!.id;
    insertMessage({
      networkId: offId,
      target: '#hidden',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: 'x',
      self: false,
    });
    closeBuffer(userId, offId, '#hidden');

    const targets = buildOfflineBacklogFrames(userId)
      .filter((f) => f.networkId === offId)
      .map((f) => f.target);
    expect(targets).not.toContain('#hidden');
    expect(targets).toContain(`:server:${offId}`);
  });
});

describe('DM_ELIGIBLE_TYPES (#439)', () => {
  it('excludes notice so a notice never reopens a closed buffer', () => {
    // The fan-out guard reopens a closed buffer on a DM-eligible event. NOTICE
    // must not be in this set: a notice to a buffer the user closed has to stay
    // closed (it's surfaced transiently in the server buffer instead).
    expect(DM_ELIGIBLE_TYPES.has('message')).toBe(true);
    expect(DM_ELIGIBLE_TYPES.has('action')).toBe(true);
    expect(DM_ELIGIBLE_TYPES.has('notice')).toBe(false);
  });
});

describe('handleOpenBuffer', () => {
  it('reopens a since-closed channel without re-JOINing, resolving casing case-insensitively', () => {
    seed('#reopen', 'history line');
    closeBuffer(userId, networkId, '#reopen');
    expect(isClosed(userId, networkId, '#reopen')).toBe(true);

    // Clicked with different casing than the stored target.
    const { ws, frames } = mockWs();
    handleOpenBuffer(ws, userId, networkId, '#ReOpen');

    // The closed flag is cleared — the buffer is reopened.
    expect(isClosed(userId, networkId, '#reopen')).toBe(false);
    // A backlog frame plus a buffer-opened frame, both keyed by the canonical
    // stored casing rather than the casing that was clicked.
    expect(frames.find((f) => f.kind === 'backlog')?.target).toBe('#reopen');
    expect(frames.find((f) => f.kind === 'buffer-opened')?.target).toBe('#reopen');
  });

  it('joins a channel with no history instead of reopening', () => {
    const { ws, frames } = mockWs();
    handleOpenBuffer(ws, userId, networkId, '#never-visited');
    // No history → no backlog frame, just a buffer-opened for the clicked target.
    expect(frames.some((f) => f.kind === 'backlog')).toBe(false);
    expect(frames.find((f) => f.kind === 'buffer-opened')?.target).toBe('#never-visited');
  });

  it('ignores blank, zero-network, and server-buffer requests', () => {
    const { ws, frames } = mockWs();
    handleOpenBuffer(ws, userId, networkId, ':server:1');
    handleOpenBuffer(ws, userId, networkId, '');
    handleOpenBuffer(ws, userId, 0, '#x');
    expect(frames).toHaveLength(0);
  });
});

// A minimal ws stand-in that counts ping/terminate calls. isAlive mirrors the
// real per-socket flag the reaper reads and writes.
function hbWs(isAlive: boolean) {
  const calls = { ping: 0, terminate: 0 };
  const ws = {
    isAlive,
    ping() {
      calls.ping += 1;
    },
    terminate() {
      calls.terminate += 1;
    },
  };
  return { ws, calls };
}

// sweepWsHeartbeat is typed for real LurkerWebSockets; the mocks only carry the
// three fields it touches, so cast at the boundary.
function sweep(wss: Array<ReturnType<typeof hbWs>['ws']>): number {
  return sweepWsHeartbeat(wss as unknown as Parameters<typeof sweepWsHeartbeat>[0]);
}

describe('sweepWsHeartbeat', () => {
  it('pings a live socket and re-arms it as pending (isAlive=false)', () => {
    const { ws, calls } = hbWs(true);
    const terminated = sweep([ws]);
    expect(calls.ping).toBe(1);
    expect(calls.terminate).toBe(0);
    expect(ws.isAlive).toBe(false);
    expect(terminated).toBe(0);
  });

  it('terminates a socket that never ponged (isAlive still false next sweep)', () => {
    const { ws, calls } = hbWs(true);
    sweep([ws]); // ping; isAlive -> false
    const terminated = sweep([ws]); // no pong arrived -> reap
    expect(calls.terminate).toBe(1);
    // A reaped socket is not re-pinged in the same sweep.
    expect(calls.ping).toBe(1);
    expect(terminated).toBe(1);
  });

  it('spares a socket that ponged between sweeps', () => {
    const { ws, calls } = hbWs(true);
    sweep([ws]); // ping; isAlive -> false
    ws.isAlive = true; // simulate the pong handler firing
    sweep([ws]); // still alive -> ping again, no terminate
    expect(calls.terminate).toBe(0);
    expect(calls.ping).toBe(2);
  });

  it('handles a mixed batch and reports the terminated count', () => {
    const live = hbWs(true); // answered last round
    const dead1 = hbWs(false); // missed last round's pong
    const dead2 = hbWs(false);
    const terminated = sweep([live.ws, dead1.ws, dead2.ws]);
    expect(terminated).toBe(2);
    expect(live.calls.terminate).toBe(0);
    expect(live.calls.ping).toBe(1);
    expect(dead1.calls.terminate).toBe(1);
    expect(dead2.calls.terminate).toBe(1);
  });
});

describe('system buffer delivery (#355)', () => {
  function sysLine(uid: number | null, over: Record<string, unknown> = {}): number {
    return systemMessages.insert({
      userId: uid,
      ts: new Date().toISOString(),
      level: 'info',
      scope: 'lurker',
      source: 'server',
      text: 'sys',
      ...over,
    }).id;
  }

  it('systemLineToEvent maps a line to the system-buffer event shape', () => {
    const row = systemMessages.insert({
      userId: null,
      ts: '2026-01-01T00:00:00.000Z',
      level: 'warn',
      scope: 'net:Libera',
      source: 'server',
      text: 'hello',
      fields: { networkId: 42 },
    });
    expect(systemLineToEvent(row)).toMatchObject({
      id: row.id,
      networkId: null,
      target: ':system:',
      type: 'system',
      originNetworkId: 42, // pulled from fields, drives the prefix-column name
      text: 'hello',
      time: '2026-01-01T00:00:00.000Z',
      level: 'warn',
      scope: 'net:Libera',
      source: 'server',
    });
    // A line with no fields.networkId is network-agnostic → originNetworkId null.
    expect(systemLineToEvent({ ...row, fields: null }).originNetworkId).toBeNull();
  });

  it('buildSystemBacklog ships a backlog frame (events oldest-first + read-state)', () => {
    const u = createUser('sys-backlog').id;
    const ids = [sysLine(u), sysLine(u), sysLine(u)];
    const frame = buildSystemBacklog(u);
    expect(frame.kind).toBe('backlog');
    expect(frame.networkId).toBeNull();
    expect(frame.target).toBe(':system:');
    expect(frame.joined).toBe(true);
    const evIds = (frame.events as Array<{ id: number }>).map((e) => e.id);
    expect(evIds.slice(-3)).toEqual(ids); // our three, oldest-first
    expect(frame).toHaveProperty('lastReadId');
    expect(frame).toHaveProperty('hasMoreOlder');
  });

  it('buildSystemHistoryReply pages older (before) and around an anchor', () => {
    const u = createUser('sys-history').id;
    const ids = Array.from({ length: 5 }, () => sysLine(u));
    const before = buildSystemHistoryReply(u, { mode: 'before', before: ids[2], limit: 50 });
    expect(before.mode).toBe('before');
    expect((before.events as Array<{ id: number }>).map((e) => e.id).slice(-2)).toEqual(
      ids.slice(0, 2),
    );
    const around = buildSystemHistoryReply(u, { mode: 'around', anchorId: ids[2], limit: 1 });
    expect((around.events as Array<{ id: number }>).map((e) => e.id)).toEqual([
      ids[1],
      ids[2],
      ids[3],
    ]);
    expect(around.hasMoreNewer).toBe(true);
  });

  it('buildSystemHistoryReply rejects a bad anchor/after id with an error frame', () => {
    const u = createUser('sys-history-bad').id;
    expect(buildSystemHistoryReply(u, { mode: 'around', anchorId: 0 })).toMatchObject({
      kind: 'error',
    });
    expect(buildSystemHistoryReply(u, { mode: 'after', afterId: -1 })).toMatchObject({
      kind: 'error',
    });
  });
});

describe('startChanlistRefresh (issue #396)', () => {
  it('wipes the prior cache so a refresh drops departed channels', () => {
    const net = createNetwork(userId, {
      name: 'chanlist-refresh',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'alice',
    });
    const nid = net!.id;

    // First /LIST: three channels land in the cache.
    chanlist.upsertChannels(nid, [
      { channel: '#a', topic: 'a', num_users: 5 },
      { channel: '#b', topic: 'b', num_users: 4 },
      { channel: '#gone', topic: 'gone', num_users: 1 },
    ]);
    expect(chanlist.countChannels(nid)).toBe(3);

    // Refresh: this is the send-time reset that no longer relies on the server
    // echoing RPL_LISTSTART (321). The cache is emptied and marked in-progress.
    startChanlistRefresh(nid);
    expect(chanlist.countChannels(nid)).toBe(0);
    expect(chanlist.getMeta(nid)).toMatchObject({
      inProgress: true,
      totalCount: 0,
      fetchedAt: null,
    });

    // The second /LIST returns a smaller set — #gone has been removed server-side.
    // Without the reset above it would survive via the additive upsert (#396).
    chanlist.upsertChannels(nid, [
      { channel: '#a', topic: 'a', num_users: 6 },
      { channel: '#b', topic: 'b', num_users: 4 },
    ]);
    const names = chanlist
      .searchChannels(nid, { sortBy: 'name', sortDir: 'asc' })
      .rows.map((r) => r.channel);
    expect(names).toEqual(['#a', '#b']);
    expect(names).not.toContain('#gone');
  });
});

// Drives the PWA app-icon badge (#451). Uses its own user/network so the shared
// per-file DB seeded by the other suites doesn't perturb the totals.
describe('computeTotalHighlights', () => {
  it('counts every buffer with history (even never-opened ones), respects read pointers, excludes closed', () => {
    const u = createUser('badger').id;
    const net = createNetwork(u, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'badger',
    })!.id;
    const ins = (target: string, text: string) =>
      Number(
        insertMessage({
          networkId: net,
          target,
          time: new Date().toISOString(),
          type: 'message',
          nick: 'bob',
          text,
          self: false,
        }).id,
      );

    // The system-buffer term is constant for this user across the test (we never
    // add notable system lines), so assert deltas against this baseline rather
    // than absolute totals — keeps the test immune to the shared per-file DB and
    // any global (user_id NULL) system messages other suites seeded.
    const base = computeTotalHighlights(u);

    // Never-opened DM (no read pointer). The client counts these from
    // lastReadId 0, so the badge total must too — this is the regression that
    // made the push badge vanish for buffers the user hadn't opened yet.
    ins('frank', 'hey');
    ins('frank', 'you around?');
    expect(computeTotalHighlights(u)).toBe(base + 2);

    // Never-opened channel, plain lines, no highlight-rule match → adds 0.
    ins('#noise', 'chatter');
    ins('#noise', 'more chatter');
    expect(computeTotalHighlights(u)).toBe(base + 2);

    // DM 'dave': read the first line, then two more arrive → contributes 2.
    const d1 = ins('dave', 'one');
    setReadState(u, net, 'dave', d1);
    ins('dave', 'two');
    const d3 = ins('dave', 'three');
    expect(computeTotalHighlights(u)).toBe(base + 4); // frank 2 + dave 2

    // Closed buffers are excluded — the client drops them from its store.
    closeBuffer(u, net, 'frank');
    expect(computeTotalHighlights(u)).toBe(base + 2);
    reopenBuffer(u, net, 'frank');
    expect(computeTotalHighlights(u)).toBe(base + 4);

    // Reading dave up to its newest line clears its contribution.
    setReadState(u, net, 'dave', d3);
    expect(computeTotalHighlights(u)).toBe(base + 2);
  });
});
