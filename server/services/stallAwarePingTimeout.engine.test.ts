// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// #1074 in engine mode, where #1070 happened: a stall past the ping timeout
// must not close a connection the engine holds, and must not turn the
// re-attach after a dropped link into a redial. The engine and the fake ircd
// run in this process, so the stall stops them too; what they wrote before it
// waits unread, as a real engine's frames do.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import ircManager from './ircManager.js';
import { ircPingTiming } from './ircConnection.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';
import type { FakeClient } from '../test-utils/fakeIrcd.js';

let harness: EngineHarness;
let userId: number;

const TIMING = { timeoutS: 1, intervalS: 0.5, probeMs: 500 };
const STALL_MS = 2500;

// From a setImmediate callback, for the reason stallAwarePingTimeout.test.ts
// gives: after a stall in a timer callback libuv happens to read first.
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

const savedTiming = { ...ircPingTiming };

beforeAll(async () => {
  Object.assign(ircPingTiming, TIMING);
  harness = await startEngineHarness({ secret: 'ping-stall-secret' });
  userId = createUser('ping-stall-engine').id;
});

afterAll(async () => {
  Object.assign(ircPingTiming, savedTiming);
  await harness.stop();
});

async function connected(nick: string) {
  const network = createNetwork(userId, {
    name: nick,
    host: '127.0.0.1',
    port: harness.ircd.port,
    tls: 0,
    nick,
    autoconnect: 0,
  })!;
  const conn = ircManager.startNetwork(userId, network.id)!;
  await harness.until(() => conn.state === 'connected', 5000, 'connected');
  const me = await harness.ircd.waitForRegistration(nick);
  return { conn, me, networkId: network.id };
}

const registrationsOf = (nick: string) =>
  harness.ircd.registrations.filter((r) => r.nick === nick).length;
const quits = (me: FakeClient) => me.sent.filter((l) => l.startsWith('QUIT'));
const settle = () => new Promise((r) => setTimeout(r, 3 * TIMING.timeoutS * 1000));

describe('a stall past the ping timeout, in engine mode (#1074)', { timeout: 20_000 }, () => {
  it('closes nothing the engine holds', async () => {
    const { conn, me, networkId } = await connected('es-alive');
    await stall(STALL_MS, () =>
      harness.ircd.sendRaw('es-alive', ':fake.server NOTICE es-alive :said during the stall'),
    );
    await settle();
    expect(quits(me)).toEqual([]);
    expect(me.socket.destroyed).toBe(false);
    expect(conn.state).toBe('connected');
    expect(registrationsOf('es-alive')).toBe(1);
    // And it got there by probing, through the engine.
    expect(me.sent.filter((l) => l.includes('lurker-stall-probe')).length).toBeGreaterThan(0);
    ircManager.stopNetwork(userId, networkId);
  });

  // #1070's shape: the engine gives up on the silent app link during the
  // stall, so when the loop comes back the link's end waits behind the expired
  // ping timer. The app must re-attach to the socket the engine kept, not
  // close it and dial again. Before the fix the timer won every time, but
  // whether its close then reached the engine (and so became a redial) was a
  // race, so the test counts the timeouts, not only the registrations.
  it('re-attaches after the engine dropped the link, without a redial', async () => {
    const { conn, me, networkId } = await connected('es-relink');
    let pingTimeouts = 0;
    conn.client.on('ping timeout', () => pingTimeouts++);
    const engineLinks = (
      harness.engine as unknown as { links: Set<{ socket: { destroy(): void } }> }
    ).links;
    await stall(STALL_MS, () => {
      for (const link of engineLinks) link.socket.destroy();
    });
    await harness.until(() => conn.state !== 'connected', 3000, 'the app noticing the link went');
    await harness.until(() => conn.state === 'connected', 5000, 're-attached');
    await settle();
    expect(pingTimeouts).toBe(0);
    expect(quits(me)).toEqual([]);
    expect(me.socket.destroyed).toBe(false);
    expect(registrationsOf('es-relink')).toBe(1);
    ircManager.stopNetwork(userId, networkId);
  });
});
