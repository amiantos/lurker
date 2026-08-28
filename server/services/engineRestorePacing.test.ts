// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The restore's per-channel state requests are paced by the server's replies,
// not by a timer: one channel in flight, the next released by the previous
// one's 366 / 331|332 / 324, with a deadline as the only fallback. Read off the
// wire against the fake ircd — the same shape an ircd's flood control judges
// (see drainRestoreQueue in ircConnection.ts).

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
import type { EngineHarness, WireLine } from '../test-utils/engineHarness.js';

const SECRET = 'restore-pacing-secret';
const CHANNELS = ['#p1', '#p2', '#p3', '#p4', '#p5', '#p6'];
// This channel's TOPIC is never answered: its step can only end by the deadline.
// (TOPIC rather than WHO: the WHO is not part of the gate, and irc-framework
// serialises WHO requests behind their 315, so a WHO held back would also wedge
// every later channel's auto-WHO — the framework's queue, not the pacing.)
const HELD = '#p3';
const DEADLINE_MS = 1500;

let harness: EngineHarness;
let ircd: FakeIrcd;
let network: Network;
let userId: number;

// Every line on the wire, in causal order — the harness's log (see WireLine
// for why '<' is stamped at the ircd and '>' at the Client); the timing
// assertions below read one clock because of it.
let wire: WireLine[];
const until = (pred: () => boolean, ms: number, what: string) => harness.until(pred, ms, what);

beforeAll(async () => {
  harness = await startEngineHarness({
    secret: SECRET,
    env: { LURKER_RESTORE_STEP_DEADLINE_MS: String(DEADLINE_MS) },
  });
  ircd = harness.ircd;
  wire = harness.wire;
  const user = createUser('restore-pacing');
  userId = user.id;
  network = createNetwork(user.id, {
    name: 'restore-pacing',
    host: '127.0.0.1',
    port: ircd.port,
    tls: 0,
    nick: 'pace',
    autoconnect: 0,
  })!;
});

afterAll(async () => {
  await harness.stop();
});

describe('engine restore pacing', () => {
  it("releases each channel on the previous one's replies, and by the deadline when one never comes", async () => {
    // A session with six channels, then the app "restarts".
    const conn = new IrcConnection({ network, onEvent: () => {} });
    conn.connect();
    await until(() => conn.state === 'connected', 5000, 'connected');
    // Let the first session's join-time WHOs finish before it lets go: a WHO
    // still in flight at detach has its 315 land in the engine's backlog and
    // replay to the next session, where it would pass for that session's own.
    const whoAnswered = new Set<string>();
    conn.client.on('raw', (ev: { line: string; from_server: boolean }) => {
      const m = ev.from_server ? /^\S+ 315 \S+ (#p\d)\b/.exec(ev.line) : null;
      if (m) whoAnswered.add(m[1]);
    });
    for (const ch of CHANNELS) conn.join(ch);
    await until(() => CHANNELS.every((ch) => conn.isChannelJoined(ch)), 5000, 'joins');
    await until(() => whoAnswered.size === CHANNELS.length, 5000, "first session's WHOs answered");
    conn.detach();
    await until(() => conn.state === 'disconnected', 5000, 'detached');
    // Only the second session's lines matter from here.
    wire.length = 0;

    ircd.hold = (cmd, p) => cmd === 'TOPIC' && (p[0] ?? '').toLowerCase() === HELD;
    const conn2 = ircManager.startNetwork(userId, network.id)!;
    harness.tap(conn2, 'pace');
    await until(() => conn2.state === 'connected', 5000, 'reattached');
    // Done when the last channel's own WHO — the one this session sent — is
    // answered.
    const last = CHANNELS[CHANNELS.length - 1];
    await until(
      () => {
        const who = wire.findIndex((w) => w.dir === '>' && w.line.startsWith(`WHO ${last}`));
        return (
          who >= 0 && wire.slice(who).some((w) => w.dir === '<' && numericFor(w.line, '315', last))
        );
      },
      DEADLINE_MS + 5000,
      "the last channel's WHO answered",
    );

    const sentIdx = (line: string) => wire.findIndex((w) => w.dir === '>' && w.line === line);
    const sentAt = (line: string) => wire[sentIdx(line)].t;
    const gotIdx = (numeric: string, chan: string) =>
      wire.findIndex((w) => w.dir === '<' && numericFor(w.line, numeric, chan));

    // Every channel was asked all four things.
    for (const ch of CHANNELS) {
      for (const cmd of ['NAMES', 'TOPIC', 'MODE']) {
        expect(sentIdx(`${cmd} ${ch}`), `${cmd} ${ch}`).toBeGreaterThanOrEqual(0);
      }
      expect(
        wire.some((w) => w.dir === '>' && w.line.startsWith(`WHO ${ch}`)),
        `WHO ${ch}`,
      ).toBe(true);
    }

    // The gate: a channel's first request goes out only after the previous
    // channel's last gated reply came in — all three of them.
    for (let i = 1; i < CHANNELS.length; i++) {
      const prev = CHANNELS[i - 1];
      if (prev === HELD) continue;
      const next = sentIdx(`NAMES ${CHANNELS[i]}`);
      for (const numeric of ['366', '324']) {
        const got = gotIdx(numeric, prev);
        expect(got, `${numeric} ${prev}`).toBeGreaterThanOrEqual(0);
        expect(got, `${numeric} ${prev} before NAMES ${CHANNELS[i]}`).toBeLessThan(next);
      }
      const topic = Math.max(gotIdx('331', prev), gotIdx('332', prev));
      expect(topic, `topic reply ${prev}`).toBeGreaterThanOrEqual(0);
      expect(topic).toBeLessThan(next);
    }

    // The fallback: the held channel's step ends at the deadline, not before —
    // and the steps that were answered did not wait for it. One clock on both
    // sides, and a timer never fires early, so the lower bound is exact.
    const afterHeld = CHANNELS[CHANNELS.indexOf(HELD) + 1];
    expect(Math.max(gotIdx('331', HELD), gotIdx('332', HELD))).toBe(-1);
    const heldWait = sentAt(`NAMES ${afterHeld}`) - sentAt(`NAMES ${HELD}`);
    expect(heldWait).toBeGreaterThanOrEqual(DEADLINE_MS - 5);
    expect(heldWait).toBeLessThan(DEADLINE_MS + 1000);
    for (let i = 1; i < CHANNELS.length; i++) {
      if (CHANNELS[i - 1] === HELD) continue;
      const gap = sentAt(`NAMES ${CHANNELS[i]}`) - sentAt(`NAMES ${CHANNELS[i - 1]}`);
      expect(gap, `gap before ${CHANNELS[i]}`).toBeLessThan(DEADLINE_MS / 2);
    }

    // The invariant an ircd's flood control judges: never more than four of
    // our restore lines unanswered at the server. Not implied by the gate
    // above — the WHO is outside it, held to one in flight by irc-framework's
    // own queue — so it is pinned here. (The held channel's TOPIC is unanswered
    // by construction, so that channel is left out.)
    let outstanding = 0;
    let peak = 0;
    for (const w of wire) {
      const m = /^(?:\S+ (?:366|331|332|324|315) \S+ |(?:NAMES|TOPIC|MODE|WHO) )(#p\d)\b/.exec(
        w.line,
      );
      if (!m || m[1] === HELD) continue;
      outstanding += w.dir === '>' ? 1 : -1;
      peak = Math.max(peak, outstanding);
    }
    expect(peak).toBeLessThanOrEqual(4);
  }, 20000);
  it('a snapshot and a `names` say which channels have not heard NAMES since the re-attach (#863)', async () => {
    // Same six channels, the app "restarts" again — this time the previous
    // session was ircManager's, so shutdown() is what lets go.
    ircManager.shutdown();
    // #p3's TOPIC is held: its step stays in flight, but its NAMES is answered.
    // #p5's NAMES is held: the restore asks once, so nothing answers it — not
    // even the deadline.
    ircd.hold = (cmd, p) => {
      const chan = (p[0] ?? '').toLowerCase();
      return (cmd === 'TOPIC' && chan === '#p3') || (cmd === 'NAMES' && chan === '#p5');
    };
    // Every `names` the manager fans out, to see the flag ride republishes too.
    const names: Array<Record<string, unknown>> = [];
    const onEvent = (e: Record<string, unknown>) => {
      if (e.type === 'names') names.push(e);
    };
    ircManager.on('event', onEvent);
    wire.length = 0;
    try {
      const conn = ircManager.startNetwork(userId, network.id)!;
      harness.tap(conn, 'pace');
      await until(() => conn.state === 'connected', 5000, 'reattached');
      const pending = (chan: string): boolean | undefined =>
        conn.snapshot().channels.find((c) => c.name.toLowerCase() === chan)?.membersPending;
      const lastNamesFor = (chan: string) =>
        [...names].reverse().find((e) => String(e.target).toLowerCase() === chan);
      const asked = (chan: string) => wire.some((w) => w.dir === '>' && w.line === `NAMES ${chan}`);

      // #p3 in flight, TOPIC owed: the step is not over, but its NAMES was
      // heard — pending is about NAMES, not the step. #p4 has not been asked.
      await until(
        () => pending('#p3') === undefined && pending('#p4') === true,
        5000,
        '#p3 step in flight',
      );
      expect(pending('#p1')).toBeUndefined();
      expect(pending('#p2')).toBeUndefined();
      expect(pending('#p6')).toBe(true);

      // #p5 asked and unanswered: pending by construction, not by timing.
      await until(() => asked('#p5'), DEADLINE_MS + 5000, 'NAMES #p5 on the wire');
      expect(pending('#p5')).toBe(true);
      // A republish in that window — here a mode on ourselves — carries the
      // flag: the client keeping its real list must not take this one.
      names.length = 0;
      ircd.sendRaw('pace', ':oper!~oper@peer.fake MODE #p5 +o pace');
      await until(() => lastNamesFor('#p5') !== undefined, 5000, 'names republished for #p5');
      expect(lastNamesFor('#p5')).toMatchObject({ membersPending: true });

      // The deadline moves the restore on and every other channel clears —
      // #p5 does not: nothing answered, so nothing is known.
      await until(
        () => CHANNELS.filter((ch) => ch !== '#p5').every((ch) => pending(ch) === undefined),
        DEADLINE_MS + 5000,
        'restore moved on',
      );
      expect(pending('#p5')).toBe(true);

      // A real NAMES — injected here, as a reply replayed from the engine's
      // backlog or a later /names would be — clears it the moment it lands.
      names.length = 0;
      ircd.sendRaw('pace', ':irc.fake 353 pace = #p5 :@pace');
      ircd.sendRaw('pace', ':irc.fake 366 pace #p5 :End of /NAMES list.');
      await until(() => lastNamesFor('#p5') !== undefined, 5000, 'names from the injected reply');
      expect(lastNamesFor('#p5')).not.toHaveProperty('membersPending');
      expect(pending('#p5')).toBeUndefined();
      // …and a republish after that is definitive too.
      names.length = 0;
      ircd.sendRaw('pace', ':oper!~oper@peer.fake MODE #p5 -o pace');
      await until(() => lastNamesFor('#p5') !== undefined, 5000, 'names republished for #p5 again');
      expect(lastNamesFor('#p5')).not.toHaveProperty('membersPending');
    } finally {
      ircManager.off('event', onEvent);
      ircd.hold = null;
    }
  }, 20000);
});

function numericFor(line: string, numeric: string, chan: string): boolean {
  return new RegExp(`^\\S+ ${numeric} \\S+ ${chan}\\b`).test(line);
}
