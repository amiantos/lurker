// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The restore's eager away-sync WHO is size-gated: on a re-attach, a channel
// over RESTORE_WHO_MAX_MEMBERS is not WHO'd (its 352-per-member reply is the
// heaviest part of the reconnect burst), while a fresh interactive join still
// WHOs at any size. Driven with the threshold pinned to 0, so every restored
// channel is "over" it and the gate is exercised deterministically without
// seeding hundreds of members.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import type { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';
import { until } from '../test-utils/until.js';

const SECRET = 'who-gate-secret';
const CHANNELS = ['#wa', '#wb', '#wc'];
let harness: EngineHarness;
let ircd: FakeIrcd;
let network: Network;
let userId: number;

const sentBy = (nick: string) => ircd.client(nick)?.sent ?? [];

beforeAll(async () => {
  harness = await startEngineHarness({
    secret: SECRET,
    env: {
      LURKER_RESTORE_STEP_DEADLINE_MS: '1500',
      // 0 → every restored channel (>= 1 member: us) is over the threshold.
      LURKER_RESTORE_WHO_MAX_MEMBERS: '0',
    },
  });
  ircd = harness.ircd;
  const user = createUser('who-gate');
  userId = user.id;
  network = createNetwork(user.id, {
    name: 'who-gate',
    host: '127.0.0.1',
    port: ircd.port,
    tls: 0,
    nick: 'gate',
    autoconnect: 0,
  })!;
});

afterAll(async () => {
  await harness.stop();
});

describe('engine restore WHO size-gate', () => {
  it('skips the away-sync WHO for restored channels over the threshold, but not a fresh join', async () => {
    const conn = new IrcConnection({ network, onEvent: () => {} });
    conn.connect();
    await until(() => conn.state === 'connected', 5000, 'connected');
    for (const ch of CHANNELS) conn.join(ch);
    await until(() => CHANNELS.every((ch) => conn.isChannelJoined(ch)), 5000, 'joins');
    // A normal join DID WHO (the gate is restore-only) — proves the ircd/route
    // work. Waited, not asserted immediately: irc-framework serialises WHO
    // behind each 315, so later channels' WHOs trail the joins (and this also
    // ensures no initial WHO is still queued when we snapshot below).
    await until(
      () => CHANNELS.every((ch) => sentBy('gate').includes(`WHO ${ch}`)),
      5000,
      'initial WHOs',
    );

    const sentBefore = sentBy('gate').length;
    conn.detach();
    await until(() => conn.state === 'disconnected', 5000, 'detached');

    const conn2 = ircManager.startNetwork(userId, network.id)!;
    await until(() => conn2.state === 'connected', 5000, 'reattached');
    // Restore runs one channel at a time; wait until the last channel's MODE
    // request (the final line of the final step) has gone out.
    const last = CHANNELS[CHANNELS.length - 1];
    await until(
      () => sentBy('gate').slice(sentBefore).includes(`MODE ${last}`),
      5000,
      'restore reached the last channel',
    );
    // Give any (skipped) WHO a beat to NOT appear.
    await new Promise((r) => setTimeout(r, 100));

    const since = sentBy('gate').slice(sentBefore);
    for (const ch of CHANNELS) {
      // The state requests still went out — the gate only drops the WHO.
      expect(since, `NAMES ${ch}`).toContain(`NAMES ${ch}`);
      expect(since, `TOPIC ${ch}`).toContain(`TOPIC ${ch}`);
      expect(since, `MODE ${ch}`).toContain(`MODE ${ch}`);
      // ...but the away-sync WHO was skipped for this restored channel.
      expect(
        since.some((l) => l === `WHO ${ch}`),
        `WHO ${ch} skipped`,
      ).toBe(false);
    }

    // A fresh interactive join still WHOs, at any size and threshold — the gate
    // is restore-scoped (restoreQuiet marks only the restored channels).
    const beforeFresh = sentBy('gate').length;
    conn2.join('#fresh');
    await until(() => conn2.isChannelJoined('#fresh'), 5000, 'fresh join');
    await until(
      () => sentBy('gate').slice(beforeFresh).includes('WHO #fresh'),
      5000,
      'fresh-join WHO',
    );
  }, 25000);
});
