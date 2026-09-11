// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine's half of #908 (ircChannelMembership.test.ts has the direct
// socket). The joined set belongs to the IRC socket, so what ends it depends on
// which socket died:
//   - the link to the engine blips: the IRC socket lives on in the engine, so
//     nothing is parted and the re-attach carries on;
//   - the engine reports the IRC socket closed: every channel is parted, and
//     the reconnect's rejoin lights it again;
//   - the IRC socket dies while the link is down: nothing could say so at the
//     time, so the re-attach that has to dial afresh parts them.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import type { FakeIrcd } from '../test-utils/fakeIrcd.js';
import type { EngineServer } from '../engine/server.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';
import { until } from '../test-utils/until.js';

type Ev = Record<string, unknown>;

let ircManager: typeof import('./ircManager.js').default;
let EngineLink: typeof import('./engineLink.js').EngineLink;
let engineConnectionId: typeof import('./engineLink.js').engineConnectionId;
let harness: EngineHarness;
let ircd: FakeIrcd;
let engine: EngineServer;
let userId: number;
let seq = 0;
const events: Ev[] = [];

beforeAll(async () => {
  // Read once at module load, so set before the imports: a closed IRC socket
  // redials in tens of ms instead of the production 2–5 s.
  process.env.LURKER_RECONNECT_BASE_MS = '50';
  process.env.LURKER_RECONNECT_JITTER_MS = '1';
  const { startEngineHarness } = await import('../test-utils/engineHarness.js');
  ircManager = (await import('./ircManager.js')).default;
  ({ EngineLink, engineConnectionId } = await import('./engineLink.js'));
  harness = await startEngineHarness({
    secret: 'membership-secret',
    // Long enough for the IRC socket to die, and the engine to let go of it,
    // while the link is still down; well inside the transport's 10 s wait for
    // the link, so the re-attach dials rather than giving up as unreachable.
    env: { LURKER_ENGINE_RETRY_BASE_MS: '1500' },
  });
  ircd = harness.ircd;
  engine = harness.engine;
  userId = createUser('engine-membership').id;
  ircManager.on('event', (e: Ev) => events.push(e));
});

afterAll(async () => {
  await harness.stop();
  delete process.env.LURKER_RECONNECT_BASE_MS;
  delete process.env.LURKER_RECONNECT_JITTER_MS;
});

function makeNetwork(nick: string): Network {
  return createNetwork(userId, {
    name: `engine-membership-${seq++}`,
    host: '127.0.0.1',
    port: ircd.port,
    tls: 0,
    nick,
    autoconnect: 0,
  })!;
}

const since = (mark: number, networkId: number) =>
  events.slice(mark).filter((e) => e.networkId === networkId);
const parted = (mark: number, networkId: number, target: string) =>
  since(mark, networkId).some((e) => e.type === 'channel-parted' && e.target === target);

async function joined(nick: string, channel: string) {
  const network = makeNetwork(nick);
  const conn = ircManager.startNetwork(userId, network.id)!;
  await until(() => conn.state === 'connected', 5000, `${nick} connected`);
  ircManager.joinChannel(userId, network.id, channel);
  await until(() => conn.isChannelJoined(channel), 5000, `${nick} joined ${channel}`);
  return { network, conn };
}

describe('channel membership through the engine', () => {
  it('a blip in the link parts nothing: the IRC socket never closed', async () => {
    const { network, conn } = await joined('blip', '#steady');
    try {
      const mark = events.length;
      EngineLink.shared().simulateLoss();
      await until(() => conn.state === 'reconnecting', 5000, 'noticed the loss');
      expect(conn.isChannelJoined('#steady')).toBe(true);
      await until(
        () =>
          conn.state === 'connected' &&
          since(mark, network.id).some((e) => e.type === 'channel-joined'),
        10000,
        're-attached',
      );
      expect(conn.isChannelJoined('#steady')).toBe(true);
      expect(parted(mark, network.id, '#steady')).toBe(false);
      expect(
        since(mark, network.id).some((e) => e.type === 'state' && e.state === 'disconnected'),
      ).toBe(false);
    } finally {
      ircManager.disposeNetwork(userId, network.id);
    }
  }, 30000);

  it('the engine reporting the IRC socket closed parts it, and the rejoin lights it again', async () => {
    const { network, conn } = await joined('dropped', '#again');
    try {
      const mark = events.length;
      const registrations = ircd.registrations.length;
      ircd.drop('dropped', false);
      await until(
        () => ircd.registrations.length > registrations && conn.isChannelJoined('#again'),
        20000,
        'rejoined on the new socket',
      );
      expect(
        since(mark, network.id)
          .filter((e) => e.target === '#again')
          .map((e) => e.type)
          .filter((t) => t === 'channel-parted' || t === 'channel-joined'),
      ).toEqual(['channel-parted', 'channel-joined']);
    } finally {
      ircManager.disposeNetwork(userId, network.id);
    }
  }, 30000);

  it('an IRC socket that died while the link was down is parted when the re-attach has to dial', async () => {
    const { network, conn } = await joined('outage', '#gap');
    const id = engineConnectionId(userId, network.id);
    try {
      const mark = events.length;
      EngineLink.shared().simulateLoss();
      await until(() => conn.state === 'reconnecting', 5000, 'noticed the loss');
      // Nobody is listening when the IRC socket goes, so the app still
      // believes it is in #gap — the state only the re-attach can correct.
      ircd.drop('outage', false);
      await until(() => !engine.hasConnection(id), 5000, 'the engine let go of the dead socket');
      expect(conn.isChannelJoined('#gap')).toBe(true);
      expect(parted(mark, network.id, '#gap')).toBe(false);

      await until(
        () => parted(mark, network.id, '#gap'),
        10000,
        'parted when the re-attach dialed',
      );
      await until(() => conn.isChannelJoined('#gap'), 10000, 'rejoined on the fresh dial');
    } finally {
      ircManager.disposeNetwork(userId, network.id);
    }
  }, 30000);
});
