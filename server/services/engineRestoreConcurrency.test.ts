// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Across re-attached connections the channel-state refresh takes turns at a
// process-wide cap, one STEP at a time (restoreGate, #842). With the cap at 1:
// steps round-robin across connections, a step's turn ends only with its last
// reply or the deadline (not its first reply), the attach itself never waits,
// and a connection that drops mid-step gives its turn up at once rather than
// at the step deadline. Read off the wire against the engine + fake ircd, like
// engineRestorePacing.test.ts.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness, WireLine } from '../test-utils/engineHarness.js';
import { setEnv } from '../test-utils/env.js';

const SECRET = 'restore-concurrency-secret';
// The first test's held step can only end by this deadline: long enough to
// tell "released by the deadline" from "released by a reply", short enough
// not to slow the suite. The second test sets its own, longer one.
const DEADLINE_MS = 1500;

interface Net {
  nick: string;
  channels: string[];
  network: Network;
}

let harness: EngineHarness;
let wire: WireLine[];
let userId: number;
const until = (pred: () => boolean, ms: number, what: string) => harness.until(pred, ms, what);

function numericFor(line: string, numeric: string, chan: string): boolean {
  return new RegExp(`^\\S+ ${numeric} \\S+ ${chan}\\b`).test(line);
}

function makeNet(nick: string, channels: string[]): Net {
  const network = createNetwork(userId, {
    name: `restore-concurrency-${nick}`,
    host: '127.0.0.1',
    port: harness.ircd.port,
    tls: 0,
    nick,
    autoconnect: 0,
  })!;
  return { nick, channels, network };
}

// A first session per network: connect, join, let the join-time WHOs finish
// (a WHO in flight at detach has its 315 land in the engine backlog and
// replay to the next session), then let go so the engine holds the socket.
async function holdInEngine(nets: Net[]): Promise<void> {
  const conns = nets.map((n) => {
    const conn = new IrcConnection({ network: n.network, onEvent: () => {} });
    conn.connect();
    return conn;
  });
  await until(() => conns.every((c) => c.state === 'connected'), 5000, 'first sessions connected');
  const whoAnswered = new Map<string, Set<string>>();
  conns.forEach((conn, i) => {
    const seen = new Set<string>();
    whoAnswered.set(nets[i].nick, seen);
    conn.client.on('raw', (ev: { line: string; from_server: boolean }) => {
      const m = ev.from_server ? /^\S+ 315 \S+ (#\S+)\b/.exec(ev.line) : null;
      if (m) seen.add(m[1].toLowerCase());
    });
    for (const ch of nets[i].channels) conn.join(ch);
  });
  await until(
    () => conns.every((c, i) => nets[i].channels.every((ch) => c.isChannelJoined(ch))),
    5000,
    'first sessions joined',
  );
  await until(
    () => nets.every((n) => n.channels.every((ch) => whoAnswered.get(n.nick)!.has(ch))),
    5000,
    "first sessions' WHOs answered",
  );
  for (const c of conns) c.detach();
  await until(
    () => conns.every((c) => c.state === 'disconnected'),
    5000,
    'first sessions detached',
  );
  // Only the second sessions' lines matter from here.
  wire.length = 0;
}

function reattach(net: Net): IrcConnection {
  const conn = ircManager.startNetwork(userId, net.network.id)!;
  harness.tap(conn, net.nick);
  return conn;
}

const sentBy = (nick: string, line: string) =>
  wire.findIndex((w) => w.dir === '>' && w.nick === nick && w.line === line);
const gotBy = (nick: string, numeric: string, chan: string) =>
  wire.findIndex((w) => w.dir === '<' && w.nick === nick && numericFor(w.line, numeric, chan));
const namesSends = () => wire.filter((w) => w.dir === '>' && w.line.startsWith('NAMES '));
const namesSentBy = (nick: string) => namesSends().filter((w) => w.nick === nick);

beforeAll(async () => {
  harness = await startEngineHarness({
    secret: SECRET,
    env: {
      LURKER_RESTORE_CONCURRENCY: '1',
      LURKER_RESTORE_STEP_DEADLINE_MS: String(DEADLINE_MS),
    },
  });
  wire = harness.wire;
  userId = createUser('restore-concurrency').id;
});

afterAll(async () => {
  await harness.stop();
});

describe('engine restore concurrency', () => {
  it('runs one step at a time across connections, round-robin, each turn ending with its last reply or the deadline', async () => {
    const nets = [
      makeNet('ga', ['#ga1', '#ga2']),
      makeNet('gb', ['#gb1', '#gb2']),
      makeNet('gc', ['#gc1', '#gc2']),
    ];
    await holdInEngine(nets);

    // One step — ga's #ga1 — never gets its 324: its NAMES and TOPIC are
    // answered at once, and the turn must still not pass until the deadline.
    // (MODE rather than WHO: the WHO is outside the gate, and irc-framework
    // serialises WHOs behind their 315.) Everything else answers instantly.
    const HELD = '#ga1';
    harness.ircd.hold = (cmd, p, c) =>
      c.nick === 'ga' && cmd === 'MODE' && (p[0] ?? '').toLowerCase() === HELD;
    try {
      // The app "restarts": every held network comes back in the same tick,
      // as on a cell.
      const conns = nets.map(reattach);
      await until(() => conns.every((c) => c.state === 'connected'), 5000, 'all re-attached');
      // Done when every network's last channel had its WHO answered.
      const done = (n: Net) => {
        const last = n.channels[n.channels.length - 1];
        const who = sentBy(n.nick, `WHO ${last}`);
        return (
          who >= 0 &&
          wire
            .slice(who)
            .some((w) => w.dir === '<' && w.nick === n.nick && numericFor(w.line, '315', last))
        );
      };
      await until(() => nets.every(done), DEADLINE_MS + 10000, 'every refresh answered');

      // Each network asked about every channel.
      for (const n of nets) {
        for (const ch of n.channels) {
          for (const cmd of ['NAMES', 'TOPIC', 'MODE', 'WHO']) {
            expect(sentBy(n.nick, `${cmd} ${ch}`), `${cmd} ${ch}`).toBeGreaterThanOrEqual(0);
          }
        }
      }

      // Round-robin: at every point of the NAMES sequence no connection is
      // more than one step ahead of another (all have the same channel count).
      const seq = namesSends();
      const counts = new Map(nets.map((n) => [n.nick, 0]));
      for (const w of seq) {
        counts.set(w.nick, counts.get(w.nick)! + 1);
        const c = [...counts.values()];
        expect(Math.max(...c) - Math.min(...c), `after ${w.nick} ${w.line}`).toBeLessThanOrEqual(1);
      }
      expect(seq).toHaveLength(6);

      // One step in flight: each step's turn ended before the next NAMES went
      // out — with all three replies in, or, for the held step, with the
      // deadline and not a moment sooner, its two answered replies
      // notwithstanding.
      for (let i = 1; i < seq.length; i++) {
        const prev = seq[i - 1];
        const next = seq[i];
        const chan = prev.line.slice('NAMES '.length);
        const nextIdx = wire.indexOf(next);
        const topic = Math.max(gotBy(prev.nick, '331', chan), gotBy(prev.nick, '332', chan));
        expect(topic, `topic reply ${chan}`).toBeGreaterThanOrEqual(0);
        expect(topic, `topic reply ${chan} before ${next.nick}'s NAMES`).toBeLessThan(nextIdx);
        const names = gotBy(prev.nick, '366', chan);
        expect(names, `366 ${chan}`).toBeGreaterThanOrEqual(0);
        expect(names, `366 ${chan} before ${next.nick}'s NAMES`).toBeLessThan(nextIdx);
        // The held step alone has no 324 and waits out the deadline (one
        // clock on both sides, and a timer never fires early); every other
        // step has its 324 in before the next NAMES and hands over promptly.
        const held = chan === HELD;
        const mode = gotBy(prev.nick, '324', chan);
        const gap = next.t - prev.t;
        expect(
          {
            chan,
            modeReplyBeforeNext: mode >= 0 && mode < nextIdx,
            waitedForDeadline: gap >= DEADLINE_MS - 5,
            handedOverPromptly: gap < DEADLINE_MS / 2,
          },
          `turn after ${chan}`,
        ).toEqual({
          chan,
          modeReplyBeforeNext: !held,
          waitedForDeadline: held,
          handedOverPromptly: !held,
        });
      }

      for (const c of conns) c.detach();
      await until(() => conns.every((c) => c.state === 'disconnected'), 5000, 'detached again');
    } finally {
      harness.ircd.hold = null;
    }
  }, 30000);

  it('a connection that drops mid-step gives its turn up at once, not at the step deadline; the attach never waited', async () => {
    // Long enough that a turn given up "at the deadline" rather than on the
    // drop is unmistakable.
    const LONG_DEADLINE_MS = 8000;
    const restoreDeadline = setEnv('LURKER_RESTORE_STEP_DEADLINE_MS', String(LONG_DEADLINE_MS));
    const a = makeNet('gd', ['#gd1', '#gd2']);
    const b = makeNet('ge', ['#ge1']);
    await holdInEngine([a, b]);

    // A's first step can only end by the deadline: its TOPIC is never answered.
    harness.ircd.hold = (cmd, p, c) =>
      c.nick === a.nick && cmd === 'TOPIC' && (p[0] ?? '').toLowerCase() === '#gd1';
    try {
      const connA = reattach(a);
      await until(() => sentBy(a.nick, 'NAMES #gd1') >= 0, 5000, "A's first step started");
      // A holds the only slot. B attaches — live at once, its umode asked at
      // once (that is one line, not what the cap bounds) — and its first step
      // waits.
      const connB = reattach(b);
      await until(() => connB.state === 'connected', 5000, 'B re-attached');
      await sleep(500);
      expect(connB.state).toBe('connected');
      expect(sentBy(b.nick, `MODE ${b.nick}`)).toBeGreaterThanOrEqual(0);
      expect(namesSentBy(b.nick)).toHaveLength(0);

      // The server drops A. Its turn comes back with the socket, and B's step
      // goes out — long before A's held step would have timed out.
      const tDrop = Date.now();
      harness.ircd.drop(a.nick);
      await until(() => namesSentBy(b.nick).length > 0, 5000, "B's first step started");
      expect(namesSentBy(b.nick)[0].t - tDrop).toBeLessThan(LONG_DEADLINE_MS / 2);
      expect(connA.state).not.toBe('connected');
    } finally {
      harness.ircd.hold = null;
      restoreDeadline();
    }
  }, 30000);

  it("replies the last process's in-flight step left in the engine backlog are the restore's, even while the first step is still queued", async () => {
    // The previous process let go with a step out; its 353/366 arrived at
    // the engine afterwards and replay to this one right after `restored`.
    // With the cap full, the channel's own step is still queued when they
    // land — and they must still be read as the restore's: here, the WHO
    // size gate (pinned to 0, so every restore WHO is skipped) has to apply
    // to the replayed 366 as it does to the step's own.
    const restoreDeadline = setEnv('LURKER_RESTORE_STEP_DEADLINE_MS', '8000');
    const restoreWhoMax = setEnv('LURKER_RESTORE_WHO_MAX_MEMBERS', '0');
    const blocker = makeNet('gy', ['#gy1']);
    const x = makeNet('gx', ['#gx1']);
    await holdInEngine([blocker, x]);
    // While no app is attached: the tail of a step the last process had out.
    harness.ircd.sendRaw(x.nick, ':fake.test 353 gx = #gx1 :gx');
    harness.ircd.sendRaw(x.nick, ':fake.test 366 gx #gx1 :End of /NAMES list');

    // The blocker takes the only slot with a step that never ends.
    harness.ircd.hold = (cmd, p, c) =>
      c.nick === blocker.nick && cmd === 'TOPIC' && (p[0] ?? '').toLowerCase() === '#gy1';
    try {
      reattach(blocker);
      await until(() => sentBy(blocker.nick, 'NAMES #gy1') >= 0, 5000, "blocker's step started");
      const connX = reattach(x);
      await until(() => connX.state === 'connected', 5000, 'X re-attached');
      await sleep(500);
      // X's step is queued, the replayed 366 has been through the userlist
      // handler, and no WHO went out for it.
      expect(namesSentBy(x.nick)).toHaveLength(0);
      expect(sentBy(x.nick, 'WHO #gx1')).toBe(-1);

      // Once its turn comes the step still asks (the replay is not credited
      // to it), and its own 366 is gated the same way.
      harness.ircd.drop(blocker.nick);
      await until(() => sentBy(x.nick, 'NAMES #gx1') >= 0, 5000, "X's step started");
      await until(
        () => wire.filter((w) => w.dir === '<' && numericFor(w.line, '366', '#gx1')).length >= 2,
        5000,
        "X's own 366",
      );
      await sleep(200);
      expect(sentBy(x.nick, 'WHO #gx1')).toBe(-1);
    } finally {
      harness.ircd.hold = null;
      restoreWhoMax();
      restoreDeadline();
    }
  }, 30000);
});
