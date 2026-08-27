// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Across re-attached connections the channel-state refresh takes turns at a
// process-wide cap (restoreGate, #842): with the cap at 1, the second
// connection's first request goes out only after the first connection's last
// gated reply came in — while the attach itself never waits, and a connection
// that drops mid-refresh gives its turn up at once rather than at the step
// deadline. Read off the wire against the engine + fake ircd, like
// engineRestorePacing.test.ts.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import { EngineServer } from '../engine/server.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { EngineLink, engineConfigured } from './engineLink.js';

const SECRET = 'restore-concurrency-secret';
// Long enough that a slot given up "at the deadline" rather than on the drop
// is unmistakable in the second test.
const DEADLINE_MS = 8000;

interface Net {
  nick: string;
  channels: string[];
  network: Network;
}

let ircd: FakeIrcd;
let engine: EngineServer;
let userId: number;

// Every line on the wire, in causal order, tagged with the connection's nick:
// '>' stamped as the Client writes it, '<' as the fake ircd sends it (before
// the relay hop, so a reply is always logged ahead of the request it releases).
interface Wire {
  t: number;
  dir: '>' | '<';
  nick: string;
  line: string;
}
const wire: Wire[] = [];

function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() > deadline) {
        const tail = wire
          .slice(-60)
          .map((w) => `${w.dir} [${w.nick}] ${w.line}`)
          .join('\n');
        return reject(new Error(`timed out waiting for ${what}; last wire lines:\n${tail}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function numericFor(line: string, numeric: string, chan: string): boolean {
  return new RegExp(`^\\S+ ${numeric} \\S+ ${chan}\\b`).test(line);
}

function makeNet(nick: string, channels: string[]): Net {
  const network = createNetwork(userId, {
    name: `restore-concurrency-${nick}`,
    host: '127.0.0.1',
    port: ircd.port,
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
}

function reattach(net: Net): IrcConnection {
  const conn = ircManager.startNetwork(userId, net.network.id)!;
  conn.client.on('raw', (ev: { line: string; from_server: boolean }) => {
    if (!ev.from_server) wire.push({ t: Date.now(), dir: '>', nick: net.nick, line: ev.line });
  });
  return conn;
}

const sentBy = (nick: string, line: string) =>
  wire.findIndex((w) => w.dir === '>' && w.nick === nick && w.line === line);
const gotBy = (nick: string, numeric: string, chan: string) =>
  wire.findIndex((w) => w.dir === '<' && w.nick === nick && numericFor(w.line, numeric, chan));
const namesSentBy = (nick: string) =>
  wire.filter((w) => w.dir === '>' && w.nick === nick && w.line.startsWith('NAMES '));

beforeAll(async () => {
  ircd = await FakeIrcd.start();
  ircd.on('sent', (line: string, c: { nick: string | null }) =>
    wire.push({ t: Date.now(), dir: '<', nick: c.nick ?? '?', line }),
  );
  engine = new EngineServer({
    secret: SECRET,
    bufferBytes: 64 * 1024,
    bufferTotalBytes: 1024 * 1024,
    version: 'test',
    log: () => {},
  });
  const { port } = await engine.listen(0, '127.0.0.1');
  process.env.LURKER_ENGINE_URL = `tcp://127.0.0.1:${port}`;
  process.env.LURKER_ENGINE_SECRET = SECRET;
  process.env.LURKER_ENGINE_RETRY_BASE_MS = '100';
  // A full-suite CI run starves the event loop; keep the link's heartbeat well
  // clear of the run so it can't drop a healthy idle link mid-test.
  process.env.LURKER_ENGINE_HEARTBEAT_MS = '600000';
  process.env.LURKER_RESTORE_STEP_DEADLINE_MS = String(DEADLINE_MS);
  process.env.LURKER_RESTORE_CONCURRENCY = '1';
  EngineLink.resetForTests();
  if (!engineConfigured()) throw new Error('engine mode did not switch on');
  userId = createUser('restore-concurrency').id;
});

afterAll(async () => {
  ircManager.shutdown();
  EngineLink.resetForTests();
  await engine.shutdown('tests done', 500);
  await ircd.close();
  delete process.env.LURKER_ENGINE_URL;
  delete process.env.LURKER_ENGINE_SECRET;
  delete process.env.LURKER_ENGINE_RETRY_BASE_MS;
  delete process.env.LURKER_ENGINE_HEARTBEAT_MS;
  delete process.env.LURKER_RESTORE_STEP_DEADLINE_MS;
  delete process.env.LURKER_RESTORE_CONCURRENCY;
});

describe('engine restore concurrency', () => {
  it('refreshes re-attached connections one at a time at cap 1, with every attach immediate', async () => {
    const nets = [
      makeNet('ga', ['#ga1', '#ga2']),
      makeNet('gb', ['#gb1', '#gb2']),
      makeNet('gc', ['#gc1', '#gc2']),
    ];
    await holdInEngine(nets);
    wire.length = 0;

    // The app "restarts": every held network comes back in the same tick, as
    // on a cell. (That the attach itself never waits at the cap is pinned by
    // the second test, where a held refresh makes the wait observable — here
    // the fake ircd answers so fast that all three refreshes are over before
    // the first poll below.)
    const conns = nets.map(reattach);
    await until(() => conns.every((c) => c.state === 'connected'), 5000, 'all re-attached');

    // Done when every network's last channel had its WHO answered.
    const done = (n: Net) => {
      const last = n.channels[n.channels.length - 1];
      const who = wire.findIndex(
        (w) => w.dir === '>' && w.nick === n.nick && w.line.startsWith(`WHO ${last}`),
      );
      return (
        who >= 0 &&
        wire
          .slice(who)
          .some((w) => w.dir === '<' && w.nick === n.nick && numericFor(w.line, '315', last))
      );
    };
    await until(() => nets.every(done), 15000, 'every refresh answered');

    // Each network asked about every channel.
    for (const n of nets) {
      for (const ch of n.channels) {
        for (const cmd of ['NAMES', 'TOPIC', 'MODE']) {
          expect(sentBy(n.nick, `${cmd} ${ch}`), `${cmd} ${ch}`).toBeGreaterThanOrEqual(0);
        }
      }
    }

    // One connection at a time: the NAMES sends form one contiguous run per
    // network — no network's refresh starts inside another's.
    const runs: string[] = [];
    for (const w of wire) {
      if (w.dir !== '>' || !w.line.startsWith('NAMES ')) continue;
      if (runs[runs.length - 1] !== w.nick) runs.push(w.nick);
    }
    expect(runs).toHaveLength(nets.length);
    expect(new Set(runs).size).toBe(nets.length);

    // And each turn is released by the previous connection's LAST gated
    // reply, not by anything earlier: its umode request (the first thing a
    // refresh sends) and its first NAMES both follow the previous network's
    // final 366 / 324 / topic reply.
    const byNick = new Map(nets.map((n) => [n.nick, n]));
    for (let i = 1; i < runs.length; i++) {
      const prev = byNick.get(runs[i - 1])!;
      const next = byNick.get(runs[i])!;
      const lastChan = prev.channels[prev.channels.length - 1];
      const topic = Math.max(gotBy(prev.nick, '331', lastChan), gotBy(prev.nick, '332', lastChan));
      const lastReply = Math.max(
        gotBy(prev.nick, '366', lastChan),
        gotBy(prev.nick, '324', lastChan),
        topic,
      );
      expect(lastReply, `last reply for ${prev.nick}`).toBeGreaterThanOrEqual(0);
      const umode = sentBy(next.nick, `MODE ${next.nick}`);
      expect(umode, `umode request from ${next.nick}`).toBeGreaterThanOrEqual(0);
      expect(umode, `${next.nick}'s umode request after ${prev.nick}'s last reply`).toBeGreaterThan(
        lastReply,
      );
      const firstNames = namesSentBy(next.nick)[0];
      expect(
        wire.indexOf(firstNames),
        `${next.nick}'s first NAMES after ${prev.nick}'s last reply`,
      ).toBeGreaterThan(lastReply);
    }

    // Nobody waited on a deadline: each hand-over followed its reply promptly.
    for (let i = 1; i < runs.length; i++) {
      const prev = byNick.get(runs[i - 1])!;
      const next = byNick.get(runs[i])!;
      const lastChan = prev.channels[prev.channels.length - 1];
      const tHandOver = namesSentBy(next.nick)[0].t;
      const tLastNames = wire[sentBy(prev.nick, `NAMES ${lastChan}`)].t;
      expect(tHandOver - tLastNames).toBeLessThan(DEADLINE_MS / 2);
    }

    for (const c of conns) c.detach();
    await until(() => conns.every((c) => c.state === 'disconnected'), 5000, 'detached again');
  }, 30000);

  it('a connection that drops mid-refresh gives its turn up at once, not at the step deadline', async () => {
    const a = makeNet('gd', ['#gd1', '#gd2']);
    const b = makeNet('ge', ['#ge1']);
    await holdInEngine([a, b]);
    wire.length = 0;

    // A's first step can only end by the deadline: its TOPIC is never answered.
    ircd.hold = (cmd, p, c) =>
      c.nick === a.nick && cmd === 'TOPIC' && (p[0] ?? '').toLowerCase() === '#gd1';
    try {
      const connA = reattach(a);
      await until(() => sentBy(a.nick, 'NAMES #gd1') >= 0, 5000, "A's refresh started");
      // A holds the only slot. B attaches — live at once — and its refresh
      // waits.
      const connB = reattach(b);
      await until(() => connB.state === 'connected', 5000, 'B re-attached');
      await sleep(500);
      expect(connB.state).toBe('connected');
      expect(namesSentBy(b.nick)).toHaveLength(0);
      expect(sentBy(b.nick, `MODE ${b.nick}`)).toBe(-1);

      // The server drops A. Its slot comes back with the socket, and B starts
      // — long before A's held step would have timed out.
      const tDrop = Date.now();
      ircd.drop(a.nick);
      await until(() => namesSentBy(b.nick).length > 0, 5000, "B's refresh started");
      expect(namesSentBy(b.nick)[0].t - tDrop).toBeLessThan(DEADLINE_MS / 2);
      expect(connA.state).not.toBe('connected');
    } finally {
      ircd.hold = null;
    }
  }, 30000);
});
