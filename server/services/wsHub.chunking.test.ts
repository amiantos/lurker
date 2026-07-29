// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The chunked connect burst (#469). sendSnapshot no longer runs as one
// uninterruptible block — it yields to the event loop every
// SNAPSHOT_CHUNK_BUFFERS buffers so a fat account on slow storage can't starve
// IRC socket I/O and trip its own ping timeouts.
//
// Yielding is exactly what makes the burst racy, so the properties that used to
// hold for free now need proving over a real socket, with an account big enough
// to span several chunks (wsHub.burst.test.ts seeds three buffers — it would
// never reach a yield, so it cannot see any of this):
//
//   1. Ordering survives chunking: every buffer frame still precedes
//      `backlog-complete`, and the burst still ends exactly once.
//   2. A live event fanned out mid-burst is HELD, not interleaved. Before
//      chunking this was impossible by construction; now it's the one behaviour
//      that could corrupt a client, because an event landing ahead of its
//      buffer's backlog frame is either wiped by a 'replace' or duplicated by an
//      'append'.
//   3. The held event is delivered, not dropped — the queue defers, it doesn't
//      discard.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-chunking');

// Comfortably more than SNAPSHOT_CHUNK_BUFFERS (16) so the burst spans many
// chunks and the client is guaranteed to be reading frames while the server is
// still building later ones.
const BUFFER_COUNT = 120;

let server: http.Server;
let userId: number;
let networkId: number;
let lateNetworkId: number;
let createSession: typeof import('../db/sessions.js').createSession;
let fanOutToUser: typeof import('./wsHub.js').fanOutToUser;
let url: string;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  const buffers = await import('../db/buffers.js');
  ({ createSession } = await import('../db/sessions.js'));
  const wsHub = await import('./wsHub.js');
  ({ fanOutToUser } = wsHub);

  userId = createUser('chunkuser').id;
  const net = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'chunkuser',
  });
  networkId = net!.id;

  // No live IRC connection in tests, so these take the offline (shell) path —
  // which is chunked by the same loop.
  for (let i = 0; i < BUFFER_COUNT; i++) {
    const target = `#chunk${i}`;
    buffers.ensureExists(userId, networkId, target);
    insertMessage({
      networkId,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: `hello ${i}`,
      self: false,
    });
  }

  // A SECOND network purely so its `:server:` buffer sits at the END of the
  // enumeration (eachUserBufferTarget walks networks in order, each network's
  // :server: first, then its rows). `:server:` is the only buffer that ships real
  // content on the offline path — every channel is a shell already — so it is the
  // only place the "was it downgraded?" question can actually be asked. Putting it
  // behind 120 buffers is what makes the mid-burst race winnable from the client.
  const net2 = createNetwork(userId, {
    name: 'oftc',
    host: 'h2',
    port: 6697,
    tls: true,
    nick: 'chunkuser',
  });
  lateNetworkId = net2!.id;
  insertMessage({
    networkId: lateNetworkId,
    target: `:server:${lateNetworkId}`,
    time: new Date().toISOString(),
    type: 'notice',
    nick: 'irc.example.net',
    text: 'server notice',
    self: false,
  });

  server = http.createServer();
  wsHub.attachWsHub(server, 'chunking-test-secret');
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

// Collect the burst. `onFrame` fires for every frame as it lands, so a caller
// can act WHILE the server is still mid-burst — the only way to observe the
// divert. Resolves shortly after `backlog-complete` rather than immediately, so
// anything the server sends just after the terminator (a flushed event) is
// captured too; resolving on the terminator would make the queue look empty.
// The socket the in-flight collectBurst is using, so an onFrame callback can send
// on it (driving an inbound verb mid-burst).
let liveSocket: WebSocket | null = null;

function collectBurst(onFrame?: (frame: Frame, index: number) => void): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const { token } = createSession(userId);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    liveSocket = ws;
    const frames: Frame[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`no backlog-complete; got ${frames.length} frames`));
    }, 8000);
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      frames.push(frame);
      onFrame?.(frame, frames.length - 1);
      if (frame.kind !== 'backlog-complete') return;
      // Give the flush a few turns to land before closing.
      setTimeout(() => {
        clearTimeout(timer);
        ws.close();
        resolve(frames);
      }, 150);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('chunked connect burst (#469)', () => {
  it('still terminates once, after every buffer frame, across many chunks', async () => {
    const frames = await collectBurst();

    expect(frames[0].kind).toBe('snapshot');
    expect(frames.at(-1)!.kind).toBe('backlog-complete');
    expect(frames.filter((f) => f.kind === 'backlog-complete')).toHaveLength(1);

    // Every seeded buffer arrived, and all of them before the terminator.
    const terminatorAt = frames.findIndex((f) => f.kind === 'backlog-complete');
    const targets = frames
      .slice(0, terminatorAt)
      .filter((f) => f.kind === 'backlog')
      .map((f) => f.target);
    for (let i = 0; i < BUFFER_COUNT; i++) expect(targets).toContain(`#chunk${i}`);
  });

  it('holds a live event fanned out mid-burst until the burst ends', async () => {
    // Fire as soon as the first buffer frame lands. With 120 buffers the server
    // is provably still building later chunks at that point, so this event races
    // the remainder of the burst — the exact window chunking opened.
    let fired = false;
    const frames = await collectBurst((frame) => {
      if (fired || frame.kind !== 'backlog') return;
      fired = true;
      fanOutToUser(userId, {
        kind: 'irc',
        id: 999_999,
        networkId,
        target: '#chunk0',
        type: 'message',
        nick: 'interloper',
        text: 'sent mid-burst',
        time: new Date().toISOString(),
      });
    });

    expect(fired).toBe(true);
    const live = frames.findIndex((f) => f.nick === 'interloper');
    const terminatorAt = frames.findIndex((f) => f.kind === 'backlog-complete');

    // Delivered, not dropped — the queue defers.
    expect(live).toBeGreaterThanOrEqual(0);
    // ...and held until after the burst, so it can neither be wiped by a
    // 'replace' frame nor duplicated into an 'append' one.
    expect(live).toBeGreaterThan(terminatorAt);
  });

  // NOTE on what this suite can and cannot reach: these tests run with no live
  // IRC connection, so every buffer takes the OFFLINE path (shells and :server:
  // frames). buildResumeSlice — the online path where a mid-burst insert could be
  // read into a slice that also queued it — is never exercised here. The burst
  // ceiling that prevents that duplicate is covered at function level instead,
  // in wsHub.test.ts ('buildResumeSlice > never ships a row newer than the burst
  // ceiling'). A socket-level version of it was tried and DELETED: it passed with
  // the ceiling removed, so it discriminated nothing.

  it('downgrades a buffer to a shell when the client hydrated it mid-burst', async () => {
    // Chunking made inbound verbs serviceable between chunks, so a user can tap a
    // buffer while the burst is still running. The `history` reply lands first
    // with a fresh slice; if the burst then shipped its own replace frame for
    // that buffer it would discard what the user just asked for, seconds later.
    // A shell says "buffer exists, leave your contents alone".
    const target = `:server:${lateNetworkId}`;
    let asked = false;
    const frames = await collectBurst((frame) => {
      if (asked || frame.kind !== 'backlog') return;
      asked = true;
      liveSocket?.send(
        JSON.stringify({ type: 'history', networkId: lateNetworkId, target, mode: 'latest' }),
      );
    });

    expect(asked).toBe(true);
    // The reply arrived, so the client really does hold a fresh slice...
    expect(frames.some((f) => f.kind === 'history' && f.target === target)).toBe(true);
    // ...and the burst's own frame for it declined to overwrite that. Without the
    // downgrade this buffer ships mode:'replace' carrying its seeded notice, which
    // is exactly what would discard the client's newer slice.
    const burstFrame = frames.find((f) => f.kind === 'backlog' && f.target === target);
    expect(burstFrame).toBeDefined();
    expect(burstFrame!.mode).toBe('shell');
    expect(burstFrame!.events).toEqual([]);
  });

  it('defers a snapshot requested mid-burst instead of dropping it', async () => {
    // Concurrent snapshots can't interleave on one socket, but the loser must not
    // be discarded: chunking made "a network finishes connecting partway through
    // the burst" a realistic race, and dropping that request would leave the
    // client with no frames for that network at all. It should run after.
    let asked = false;
    const frames = await new Promise<Frame[]>((resolve, reject) => {
      const { token } = createSession(userId);
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      const collected: Frame[] = [];
      const timer = setTimeout(() => {
        ws.close();
        reject(
          new Error(
            `bursts=${collected.filter((f) => f.kind === 'backlog-complete').length} kinds=${collected
              .map((f) => f.kind)
              .join(',')
              .slice(0, 300)}`,
          ),
        );
      }, 3500);
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as Frame;
        collected.push(frame);
        // Ask for a resync while the first burst is provably still going.
        if (!asked && frame.kind === 'backlog') {
          asked = true;
          // `type`, not `kind` — inbound verbs dispatch on type; kind is the
          // outbound frame discriminator.
          ws.send(JSON.stringify({ type: 'snapshot' }));
          return;
        }
        // Stop once the SECOND terminator lands — that's the deferred run.
        if (collected.filter((f) => f.kind === 'backlog-complete').length < 2) return;
        clearTimeout(timer);
        ws.close();
        resolve(collected);
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(asked).toBe(true);
    // Two complete bursts, not one — the deferred request ran rather than being
    // swallowed by the in-flight guard.
    expect(frames.filter((f) => f.kind === 'backlog-complete')).toHaveLength(2);
    // And they didn't interleave: the second burst's own 'snapshot' frame comes
    // after the first burst's terminator.
    const firstEnd = frames.findIndex((f) => f.kind === 'backlog-complete');
    const snapshots = frames.map((f, i) => (f.kind === 'snapshot' ? i : -1)).filter((i) => i >= 0);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toBeGreaterThan(firstEnd);
  });
});
