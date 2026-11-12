// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// #1074: an event-loop stall longer than the ping timeout must not close a
// healthy connection, and a server that has really gone silent must still be
// closed. The stall here is real: the test blocks its own loop, and the fake
// ircd is in the same process, so what it wrote before the stall waits unread
// in the socket exactly as a real server's lines do. Timings are shrunk through
// ircPingTiming so a stall past them takes seconds, not minutes.

import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import type { FakeClient } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';
import type { IrcConnection as IrcConnectionT } from './ircConnection.js';
import { MAX_PROBES } from './stallAwarePingTimeout.js';

let IrcConnection: typeof import('./ircConnection.js').IrcConnection;
let ircPingTiming: typeof import('./ircConnection.js').ircPingTiming;
let ircd: FakeIrcd;
let userId: number;
let conn: IrcConnectionT | null = null;

// The library's keepalive PINGs every 0.5 s, so a connection that isn't stalled
// always hears from the server well inside the 1 s timeout. The socket's idle
// timeout is their sum, 1.5 s: a 2.5 s stall overruns both.
const TIMING = { timeoutS: 1, intervalS: 0.5, probeMs: 500 };
let savedTiming: typeof TIMING;
const STALL_MS = 2500;

// Blocks the loop from a setImmediate callback. The phase matters: after a
// stall in the poll phase (a WS message or an HTTP request running a slow
// query, the usual culprit) or the check phase, libuv runs the expired timers
// before it reads the waiting lines, which is the bug. After a stall inside a
// timer callback it happens to read first, so a stall from there would pass
// without the fix.
function stall(ms: number, before?: () => void): Promise<void> {
  return new Promise((resolve) =>
    setImmediate(() => {
      before?.();
      const end = performance.now() + ms;
      while (performance.now() < end) {
        /* the stall */
      }
      resolve();
    }),
  );
}

beforeAll(async () => {
  ({ IrcConnection, ircPingTiming } = await import('./ircConnection.js'));
  savedTiming = { ...ircPingTiming };
  Object.assign(ircPingTiming, TIMING);
  ircd = await FakeIrcd.start({});
  userId = createUser('ping-stall').id;
});

afterEach(() => {
  conn?.disconnect();
  conn = null;
});

afterAll(async () => {
  Object.assign(ircPingTiming, savedTiming);
  await ircd.close();
});

async function connected(nick: string): Promise<FakeClient> {
  const network = createNetwork(userId, {
    name: nick,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  })!;
  conn = new IrcConnection({ network, onEvent: () => {} });
  conn.connect();
  await until(() => conn!.state === 'connected', 5000, 'connected');
  return ircd.waitForRegistration(nick);
}

const registrationsOf = (nick: string) => ircd.registrations.filter((r) => r.nick === nick).length;
const quits = (me: FakeClient) => me.sent.filter((l) => l.startsWith('QUIT'));
const probes = (me: FakeClient) => me.sent.filter((l) => l.includes('lurker-stall-probe'));

describe('a stall past the ping timeout (#1074)', { timeout: 15_000 }, () => {
  // The socket's idle timeout fires after a stall just as the ping timer does,
  // and closes without a probe. Whether it beats the ping timer to it depends
  // on how Node orders its timer lists, so the stall tests below catch it left
  // on only some of the time; this pins it off, and pins the library's
  // internals ircConnection reaches through to turn it off.
  it("turns the socket's own idle timeout off once connected, and back on for a QUIT", async () => {
    await connected('idle-off');
    const internals = conn!.client as unknown as {
      connection: { transport: { socket: { timeout?: number } } };
    };
    const socket = internals.connection.transport.socket;
    expect(socket.timeout).toBe(0);
    // A QUIT that a dead route never lets out must still end the socket.
    conn!.disconnect();
    expect(socket.timeout).toBe(10_000);
  });

  it('closes nothing when the server kept talking through it', async () => {
    const me = await connected('stall-alive');
    // Written before the stall, read only after it: the line a real server
    // sends while we aren't listening.
    await stall(STALL_MS, () =>
      ircd.sendRaw('stall-alive', ':fake.server NOTICE stall-alive :said during the stall'),
    );

    // Several timeout windows of normal running after it.
    await new Promise((r) => setTimeout(r, 3 * TIMING.timeoutS * 1000));
    expect(quits(me)).toEqual([]);
    expect(me.socket.destroyed).toBe(false);
    expect(conn!.state).toBe('connected');
    expect(registrationsOf('stall-alive')).toBe(1);
    // And it got there by probing.
    expect(probes(me).length).toBeGreaterThan(0);
  });

  it('still closes a server that went silent, after the probe goes unanswered', async () => {
    const me = await connected('stall-dead');
    ircd.silence('stall-dead');
    await stall(STALL_MS);

    await until(() => quits(me).length > 0, 5000, 'the QUIT');
    expect(probes(me).length).toBeGreaterThan(0);
    expect(quits(me)[0]).toMatch(/Ping timeout/);
    expect(registrationsOf('stall-dead')).toBe(1);
  });

  // A probe window stalled through proves nothing, so it probes again, but
  // only so often: a dead server on a loop that keeps stalling still closes.
  it('stops re-probing a silent server after MAX_PROBES, however often the loop stalls', async () => {
    const me = await connected('stalls-dead');
    ircd.silence('stalls-dead');
    // A line written just before the silence (a keepalive's PONG) may still
    // be on its way, and reading it rightly starts the count over. Let it
    // land, and count only the probes after it.
    await new Promise((r) => setTimeout(r, 200));
    const from = me.sent.length;
    await stall(STALL_MS);
    // Each stall outlasts the probe window before it, so every window fires late.
    for (let i = 0; i < 6; i++) await stall(TIMING.probeMs * 2);

    await until(() => quits(me).length > 0, 5000, 'the QUIT');
    const counted = me.sent.slice(from).filter((l) => l.includes('lurker-stall-probe'));
    expect(counted.length).toBeGreaterThan(1);
    expect(counted.length).toBeLessThanOrEqual(MAX_PROBES);
  });

  it('closes a silent server after one unanswered probe when nothing stalled', async () => {
    const me = await connected('quiet-dead');
    ircd.silence('quiet-dead');

    await until(() => quits(me).length > 0, 5000, 'the QUIT');
    expect(probes(me).length).toBeGreaterThan(0);
    expect(quits(me)[0]).toMatch(/Ping timeout/);
  });
});
