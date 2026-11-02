// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The re-attach's channel walk is paced by the server's replies alone. Charging
// its NAMES/TOPIC/MODE to the connection's flood clock as well (#1149) made each
// step wait 6 s on top of the reply it was already waiting for, while holding
// its turn at the process-wide cap (#842): a 42-connection cell took 221 s to
// see its topics and member lists again after a restart. So this file runs with
// flood pacing ON, which the suite otherwise turns off, and asks the whole walk
// to be done in the time one paced step would take.

import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness, WireLine } from '../test-utils/engineHarness.js';

const SECRET = 'restore-unpaced-secret';
const CHANNELS = ['#u1', '#u2', '#u3', '#u4', '#u5', '#u6'];
const STEP_LINE = /^(?:NAMES|TOPIC|MODE) #u\d$/;

let harness: EngineHarness;
let network: Network;
let userId: number;
let wire: WireLine[];

beforeAll(async () => {
  harness = await startEngineHarness({
    secret: SECRET,
    // Paced like production (the suite default is 0 = free). The away-sync
    // WHO stays on, as in production: it sits in the same lane ahead of the
    // next channel's step, so a charged one would hold the walk too.
    env: { LURKER_SEND_PACING: '1' },
  });
  wire = harness.wire;
  const user = createUser('restore-unpaced');
  userId = user.id;
  network = createNetwork(user.id, {
    name: 'restore-unpaced',
    host: '127.0.0.1',
    port: harness.ircd.port,
    tls: false,
    nick: 'unpaced',
    autoconnect: false,
  })!;
});

afterAll(async () => {
  await harness.stop();
});

describe('the re-attach walk against the flood clock', () => {
  it("asks every channel's NAMES/TOPIC/MODE as fast as the server answers, not one line per 2 s", async () => {
    const conn = new IrcConnection({ network, onEvent: () => {} });
    conn.connect();
    await harness.until(() => conn.state === 'connected', 5000, 'connected');
    for (const ch of CHANNELS) conn.join(ch);
    await harness.until(() => CHANNELS.every((ch) => conn.isChannelJoined(ch)), 10000, 'joins');
    conn.detach();
    await harness.until(() => conn.state === 'disconnected', 5000, 'detached');
    wire.length = 0;

    const conn2 = ircManager.startNetwork(userId, network.id)!;
    harness.tap(conn2, 'unpaced');
    await harness.until(() => conn2.state === 'connected', 5000, 'reattached');
    const steps = () => wire.filter((w) => w.dir === '>' && STEP_LINE.test(w.line));
    // Eighteen lines plus six WHOs. Waiting on the clock, the nineteen past
    // the five-line burst budget would need 38 s, and the six WHOs alone 12 s;
    // paced by the replies alone they take a few round trips. The bounds are
    // loose for a loaded suite and still well under either charged figure.
    // The last channel's WHO is drawn by its 366, which lands after its MODE
    // went: wait for the WHOs too, not only the walk's own lines.
    const whos = () => wire.filter((w) => w.dir === '>' && /^WHO #u\d\b/.test(w.line));
    await harness.until(
      () => steps().length === CHANNELS.length * 3 && whos().length === CHANNELS.length,
      10000,
      'the whole walk and its WHOs sent',
    );
    const sent = steps();
    expect(sent.at(-1)!.t - sent[0].t).toBeLessThan(8000);
    expect(
      whos()
        .map((w) => w.line.split(' ')[1])
        .toSorted(),
    ).toEqual([...CHANNELS].toSorted());
    expect(whos().at(-1)!.t - sent[0].t).toBeLessThan(8000);
    for (const ch of CHANNELS) {
      expect(sent.map((w) => w.line)).toEqual(
        expect.arrayContaining([`NAMES ${ch}`, `TOPIC ${ch}`, `MODE ${ch}`]),
      );
    }
    conn2.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  }, 30_000);
});
