// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The whole stack in one process: a real IrcConnection with a real (scratch)
// database, through the engine, against the fake ircd — then a SECOND
// IrcConnection attached to the socket the first one left behind. This is the
// test the plan calls the killer: a redeploy is, to the engine, exactly "dispose
// one IrcConnection, build another".
//
// What must be true afterwards, and is asserted here:
//   - the network saw one registration, and no NICK/USER/CAP after the restart;
//   - the restore wrote NO history (no "Connecting…", no MOTD, no own-join row,
//     no "Connected as"), while everything that happened during the gap did
//     land — once, in order, with a KICK from the gap honoured;
//   - the connect commands did not run again and the autojoin list was not
//     re-JOINed (a channel we were kicked from stays left);
//   - losing the link to the engine re-attaches without a 'disconnected' state
//     or an error row; shutdown detaches; dispose still QUITs.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import db from '../db/index.js';
import * as messagesDb from '../db/messages.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { setUserPaused } from '../db/users.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import type { EngineServer } from '../engine/server.js';
import { DEFAULT_CAPS } from '../test-utils/fakeIrcd.js';
import type { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';
import { until as poll } from '../test-utils/until.js';
import { TestLink } from '../test-utils/engineLink.js';
import { instanceId } from '../db/instanceId.js';
import { EngineLink, engineConnectionId, isOurConnectionId } from './engineLink.js';

// The real module, every export wrapped so a test can ask whether the content
// probe was consulted (#1068).
vi.mock('../db/messages.js', { spy: true });

const SECRET = 'integration-secret';

let harness: EngineHarness;
let ircd: FakeIrcd;
let engine: EngineServer;
let network: Network;
let userId: number;
let engineId: string;

type Ev = Record<string, unknown>;
const managerEvents: Ev[] = [];

interface Row {
  id: number;
  type: string;
  target: string;
  text: string | null;
  nick: string | null;
}
const rows = (): Row[] =>
  db
    .prepare('SELECT id, type, target, text, nick FROM messages WHERE network_id = ? ORDER BY id')
    .all(network.id) as Row[];

// On a timeout, where things stood: the connection, the link, the manager's
// state timeline, and what the engine still holds.
const until = (pred: () => boolean, ms = 5000, what = 'condition') =>
  poll(pred, ms, what, () => {
    const conn = ircManager.getConnection(userId, network.id);
    return `conn.state=${conn?.state} link=${EngineLink.shared().state} states=${JSON.stringify(stateEvents(managerEvents))} held=${engine.held()}`;
  });

beforeAll(async () => {
  harness = await startEngineHarness({
    secret: SECRET,
    // Two caps nothing asks for at registration: irc-framework doesn't want
    // them and neither does IrcConnection, so they are there for a LATER app
    // version to discover on an already-registered socket. One the server
    // grants, one it advertises and then refuses. (#888)
    ircd: {
      caps: [...DEFAULT_CAPS, 'draft/channel-rename', 'draft/refused', 'draft/granted'],
      refuse: ['draft/refused'],
    },
  });
  ircd = harness.ircd;
  engine = harness.engine;

  const user = createUser('engine-int');
  userId = user.id;
  network = createNetwork(user.id, {
    name: 'engine-int',
    host: '127.0.0.1',
    port: ircd.port,
    tls: 0,
    nick: 'lurk',
    autoconnect: 0,
    // A raw line the fake ircd answers harmlessly, and that is visible in what
    // the client sent — so "the connect commands ran" is a wire fact.
    connect_commands: 'PING connectcmd',
  })!;
  engineId = engineConnectionId(userId, network.id);
  ircManager.on('event', (e: Ev) => managerEvents.push(e));
});

afterAll(async () => {
  await harness.stop();
});

const sentBy = (nick: string) => ircd.client(nick)?.sent ?? [];
const stateEvents = (events: Ev[]) =>
  events.filter((e) => e.type === 'state').map((e) => e.state as string);

describe('IrcConnection through the engine', () => {
  let rowsBeforeDetach = 0;
  let sentBeforeDetach = 0;

  it('connects, persists, joins and runs its connect commands like a socket would', async () => {
    const events: Ev[] = [];
    const conn = new IrcConnection({ network, onEvent: (e) => events.push(e as Ev) });
    conn.connect();
    await until(() => conn.state === 'connected', 5000, 'connected');
    await until(() => sentBy('lurk').includes('PING connectcmd'), 5000, 'connect command');
    conn.join('#stay');
    conn.join('#gone');
    await until(
      () => conn.isChannelJoined('#stay') && conn.isChannelJoined('#gone'),
      5000,
      'joins',
    );
    // Normal history: the connecting notice, the MOTD, our own joins.
    const types = rows().map((r) => r.type);
    expect(types).toContain('notice');
    expect(types).toContain('motd');
    expect(rows().filter((r) => r.type === 'join' && r.nick === 'lurk')).toHaveLength(2);
    expect(
      rows().some((r) => r.type === 'notice' && (r.text ?? '').startsWith('Connecting to ')),
    ).toBe(true);
    expect(ircd.registrations.filter((r) => r.nick === 'lurk')).toHaveLength(1);
    expect(stateEvents(events)).toContain('connected');

    // A join provokes MODE #chan (the join handler) and, after 366, WHO #chan
    // (away sync) — and the WHOs go out one at a time, the second a round trip
    // after the first. They are still crossing app → link → engine → ircd when
    // the joins are seen here; let the LAST of them land before the wire is
    // sampled, or it counts as sent by the dead process below (and a late
    // MODE #stay as a fourth #stay state line on re-attach). The socket is
    // ordered, so a landed WHO #gone implies everything before it landed.
    await until(
      () => ['WHO #stay', 'WHO #gone'].every((l) => sentBy('lurk').includes(l)),
      5000,
      'join MODEs and WHOs on the wire',
    );

    // The app "shuts down": detach, never QUIT.
    rowsBeforeDetach = rows().length;
    sentBeforeDetach = sentBy('lurk').length;
    conn.detach();
    await until(() => conn.state === 'disconnected', 5000, 'detached');
    expect(engine.held()).toContain(engineId);
    expect(ircd.client('lurk')).toBeDefined();
    // Nothing more went to the wire from the dead process — in particular no QUIT.
    expect(sentBy('lurk').slice(sentBeforeDetach)).toEqual([]);
  }, 30000);

  it('a new IrcConnection re-attaches with no new history and no re-registration', async () => {
    // Life while the app is away — and it has to have REACHED the engine
    // before the app re-attaches, or it is live traffic rather than backlog.
    // A server's socket is free to hold small writes back behind an unacked
    // one (Nagle, ~40 ms on Linux), and a link with no such delay attaches
    // well inside that window; a fixed sleep here was a coin toss.
    const buffered = () => engine.info(engineId)?.bufferedLines ?? 0;
    const bufferedBefore = buffered();
    ircd.kick('#gone', 'lurk');
    ircd.say('peer', '#stay', 'while away');
    ircd.say('peer', 'lurk', 'dm while away');
    await until(() => buffered() >= bufferedBefore + 3, 5000, 'the engine buffered the gap');
    managerEvents.length = 0;

    // Through ircManager this time, so the autojoin listener is on.
    const conn = ircManager.startNetwork(userId, network.id)!;
    expect(conn).toBeTruthy();
    await until(() => conn.state === 'connected', 5000, 'reattached');
    await until(() => rows().length >= rowsBeforeDetach + 3, 5000, 'backlog persisted');

    // The gap's messages — the deterministic part — persisted once each, in
    // order, with no re-registration and no duplication. (Two things here are
    // deliberately NOT pinned, because they race on a sub-second window and are
    // covered elsewhere: whether the restore's MODE/WHO replies surface as
    // transient `motd` rows, exactly as a normal reconnect's do; and whether
    // the self-KICK for #gone persists a row, which depends on
    // whether the engine had already reconciled #gone out of the replay when the
    // app attached. What must never happen — the #829 property — is a duplicate.)
    const added = rows().slice(rowsBeforeDetach);
    const messages = added.filter((r) => r.type === 'message');
    expect(messages.map((r) => [r.target, r.text])).toEqual([
      ['#stay', 'while away'],
      ['peer', 'dm while away'],
    ]);
    // No substantive line delivered twice by an at-least-once hand-over.
    const keys = added
      .filter((r) => r.type === 'message' || r.type === 'kick')
      .map((r) => `${r.type}:${r.target}:${r.text}`);
    expect(new Set(keys).size).toBe(keys.length);
    // If a kick row landed at all, it is #gone's — never a stray.
    expect(added.filter((r) => r.type === 'kick').every((r) => r.target === '#gone')).toBe(true);

    // Live state came from the replay.
    expect(conn.currentNick).toBe('lurk');
    expect(conn.isChannelJoined('#stay')).toBe(true);
    expect(conn.isChannelJoined('#gone')).toBe(false);
    expect(stateEvents(managerEvents)).toContain('connected');
    expect(stateEvents(managerEvents)).not.toContain('disconnected');

    // The wire. The restore's channel-state requests go out the instant the
    // replay ends, but "went out" here means what the ircd RECEIVED, three
    // socket hops (app → link → engine → ircd) later — so wait for them, not a
    // clock. Then, once `live` has run its callbacks (the manager's rejoin),
    // say something: the PRIVMSG is written after anything a regression could
    // have written — a JOIN at `live`, a re-run connect command — on the same
    // ordered socket, so its arrival bounds the negative checks below.
    const since = () => sentBy('lurk').slice(sentBeforeDetach);
    const stateRequests = () => since().filter((l) => /^(MODE|NAMES|TOPIC) #stay$/.test(l));
    await until(() => stateRequests().length >= 3, 5000, 'channel-state requests on the wire');
    await until(() => !conn.catchingUp, 5000, 'live');
    conn.say('#stay', 'back');
    await ircd.waitForLine((l) => /^PRIVMSG #stay :?back$/.test(l));

    // The network saw: MODE/NAMES/TOPIC for the synthesised join, nothing else.
    // No registration, no connect command, no JOIN of the autojoin list.
    expect(ircd.registrations.filter((r) => r.nick === 'lurk')).toHaveLength(1);
    expect(since().some((l) => /^(NICK|USER|CAP|JOIN) /.test(l))).toBe(false);
    expect(stateRequests().sort()).toEqual(['MODE #stay', 'NAMES #stay', 'TOPIC #stay']);
    expect(since().filter((l) => l === 'PING connectcmd')).toHaveLength(0);
    expect(ircd.client('lurk')!.channels.has('#gone')).toBe(false);
  }, 30000);

  it('losing the link to the engine re-attaches without a disconnect', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    managerEvents.length = 0;
    const rowsBefore = rows().length;
    const sentBefore = sentBy('lurk').length;
    // The caps the connection had when it said 'connected' again, read at the
    // moment the event fires, as the bouncer reads them.
    let capsAtConnected: string[] = [];
    const watchCaps = (e: Ev) => {
      if (e.type === 'state' && e.state === 'connected') {
        capsAtConnected = [...conn.client.network.cap.enabled].toSorted();
      }
    };
    ircManager.on('event', watchCaps);
    EngineLink.shared().simulateLoss();
    // The whole cycle can finish inside one poll interval, so read the trail of
    // state events rather than sampling conn.state.
    await until(
      () => {
        const trail = stateEvents(managerEvents);
        return (
          trail.includes('reconnecting') &&
          trail.lastIndexOf('connected') > trail.indexOf('reconnecting')
        );
      },
      5000,
      'reconnecting → connected',
    );
    expect(conn.state).toBe('connected');
    await new Promise((r) => setTimeout(r, 50));
    expect(stateEvents(managerEvents)).not.toContain('disconnected');
    // Every state on the way back says it was the engine link that moved, not
    // the network, so an attached IRC client is told nothing (bouncer.ts). The
    // 'connected' at the end needs no flag: it re-asserts the state the client
    // was already in.
    const midway = managerEvents.filter((e) => e.type === 'state' && e.state !== 'connected');
    expect(midway.length).toBeGreaterThan(0);
    expect(midway.every((e) => e.engineLink === true)).toBe(true);
    // And what the bouncer reads when that unflagged 'connected' arrives: the
    // replayed CAP exchange runs ahead of the 001 that publishes it, so the
    // network's caps are back. Were they not, every attached client's
    // pass-through caps would be taken away and re-offered (bouncer.ts
    // updateSupportedCaps) on every engine blip.
    expect(capsAtConnected.length).toBeGreaterThan(0);
    expect(capsAtConnected).toEqual([...conn.client.network.cap.enabled].toSorted());
    ircManager.off('event', watchCaps);
    expect(
      rows()
        .slice(rowsBefore)
        .filter((r) => r.type === 'error' || r.type === 'notice'),
    ).toEqual([]);
    expect(ircd.registrations.filter((r) => r.nick === 'lurk')).toHaveLength(1);
    expect(
      sentBy('lurk')
        .slice(sentBefore)
        .some((l) => /^(NICK|USER|CAP|QUIT) /.test(l)),
    ).toBe(false);
    ircd.say('peer', '#stay', 'after link loss');
    await until(
      () => rows().some((r) => r.text === 'after link loss'),
      5000,
      'message after re-attach',
    );
  }, 20000);

  it('skips a msgid it already has, in catch-up and after', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    const feed = (msgid: string, text: string) =>
      conn.client.connection.addReadBuffer(
        `@msgid=${msgid} :peer!~peer@peer.fake PRIVMSG #stay :${text}`,
      );
    const count = (text: string) => rows().filter((r) => r.text === text).length;
    // The hand-over window: the same line twice is one row.
    conn.catchingUp = true;
    feed('dup-1', 'seen twice in catch-up');
    feed('dup-1', 'seen twice in catch-up');
    expect(count('seen twice in catch-up')).toBe(1);
    // Steady state too: a server can send a line twice with the same msgid.
    conn.catchingUp = false;
    feed('dup-2', 'steady state');
    feed('dup-2', 'steady state');
    expect(count('steady state')).toBe(1);
    // And catch-up never drops a line it has NOT seen.
    conn.catchingUp = true;
    feed('fresh-1', 'new in catch-up');
    expect(count('new in catch-up')).toBe(1);
    conn.catchingUp = false;
  });

  it('skips a re-delivered line by its engine seq, with no content probe (#1068)', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    const probe = vi.mocked(messagesDb.hasRecentMessageLike);
    probe.mockClear();
    const count = (text: string) => rows().filter((r) => r.text === text).length;
    const buffered = () => engine.info(engineId)?.bufferedLines ?? 0;

    // The process "dies" between the row and the ack: the line's handlers have
    // run (the row and the mark are committed, the manager has fanned the
    // message out), and the link is destroyed on the next tick — ahead of the
    // microtask that sends the ack, which goes nowhere. The engine therefore
    // re-delivers the line at re-attach. A second line is sent in the same
    // tick: it reaches the engine with no link to deliver it on, so it is
    // backlog too, above the mark — the positive control, the line the probe
    // IS asked about.
    const untagged = (text: string) =>
      ircd.sendRaw('lurk', `:peer!~peer@peer.fake PRIVMSG #stay :${text}`);
    const onEvent = (e: Ev) => {
      if (e.type !== 'message' || e.text !== 'ack lost') return;
      ircManager.off('event', onEvent);
      process.nextTick(() => {
        untagged('while cut');
        EngineLink.shared().simulateLoss();
      });
    };
    ircManager.on('event', onEvent);
    managerEvents.length = 0;
    // Untagged, as Libera or ZNC would send it: with a msgid the index seek
    // settles the repeat on its own, and this is about the line that has none.
    untagged('ack lost');
    await until(() => count('ack lost') === 1, 5000, 'the line was stored once');
    // Neither acked: the engine still holds both.
    await until(() => buffered() >= 2, 5000, 'the engine kept both unacked lines');
    const marks = () =>
      db
        .prepare('SELECT socket, seq FROM engine_marks WHERE network_id = ?')
        .all(network.id) as Array<{
        socket: string;
        seq: number;
      }>;
    expect(marks()).toHaveLength(1);
    expect(marks()[0].seq).toBeGreaterThan(0);

    await until(
      () => {
        const trail = stateEvents(managerEvents);
        return (
          trail.includes('reconnecting') &&
          trail.lastIndexOf('connected') > trail.indexOf('reconnecting')
        );
      },
      5000,
      'reconnecting → connected',
    );
    await until(() => !conn.catchingUp, 5000, 'live');
    // Acked by the new attach, so the engine let go of it.
    await until(() => buffered() === 0, 5000, 'the backlog was acked');

    // Both once. The stored one was settled by the mark — the probe was never
    // asked about it — while the one above the mark went through the probe,
    // as every line did before.
    expect(count('ack lost')).toBe(1);
    expect(count('while cut')).toBe(1);
    expect(probe.mock.calls.some((c) => c[4] === 'while cut')).toBe(true);
    expect(probe.mock.calls.some((c) => c[4] === 'ack lost')).toBe(false);
    // Acked under the new attach, and the only row is this socket's.
    expect(marks()).toHaveLength(1);
    // A fresh line after `live` is new, and stored.
    ircd.sendRaw('lurk', ':peer!~peer@peer.fake PRIVMSG #stay :after the mark');
    await until(() => count('after the mark') === 1, 5000, 'a live line after re-attach');
  }, 20000);

  it('a process that dies mid-batch leaves the whole batch to the next one (#1286)', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    const probe = vi.mocked(messagesDb.hasRecentMessageLike);
    probe.mockClear();
    const count = (text: string) => rows().filter((r) => r.text === text).length;
    const buffered = () => engine.info(engineId)?.bufferedLines ?? 0;
    await until(() => buffered() === 0, 5000, 'nothing unacked before the batch');
    const peer = ':peer!~peer@peer.fake';

    // A multiline message starts, and a plain line arrives before it ends:
    // stored at once, while irc-framework still holds the batch's first line.
    // The process dies there — a while later, so every ack it was going to
    // send has gone — and the batch ends with nobody attached.
    const onEvent = (e: Ev) => {
      if (e.type !== 'message' || e.text !== 'plain mid-batch') return;
      ircManager.off('event', onEvent);
      setTimeout(() => {
        EngineLink.shared().simulateLoss();
        ircd.sendRaw('lurk', `@batch=ml ${peer} PRIVMSG #stay :batched two`);
        ircd.sendRaw('lurk', ':fake.server BATCH -ml');
      }, 50);
    };
    ircManager.on('event', onEvent);
    managerEvents.length = 0;
    ircd.sendRaw('lurk', `${peer} BATCH +ml draft/multiline #stay`);
    ircd.sendRaw('lurk', `@batch=ml ${peer} PRIVMSG #stay :batched one`);
    ircd.sendRaw('lurk', `${peer} PRIVMSG #stay :plain mid-batch`);

    await until(
      () => {
        const trail = stateEvents(managerEvents);
        return (
          trail.includes('reconnecting') &&
          trail.lastIndexOf('connected') > trail.indexOf('reconnecting')
        );
      },
      5000,
      'reconnecting → connected',
    );
    await until(() => !conn.catchingUp, 5000, 'live');
    await until(() => buffered() === 0, 5000, 'the backlog was acked');

    // The message is whole, once. The plain line came again with the batch
    // (an ack is a watermark) and was settled by the mark its row moved while
    // the batch was open, not by the probe.
    expect(count('batched one\nbatched two')).toBe(1);
    expect(count('plain mid-batch')).toBe(1);
    expect(probe.mock.calls.some((c) => c[4] === 'plain mid-batch')).toBe(false);
  }, 20000);

  it('restartNetwork dials afresh: no restore of the quitting session, no reconnect row', async () => {
    const before = ircManager.getConnection(userId, network.id)!;
    expect(before.state).toBe('connected');
    const rowsBefore = rows().length;
    managerEvents.length = 0;
    const conn = ircManager.restartNetwork(userId, network.id, 'restart in test')!;
    expect(conn).not.toBe(before);
    await until(() => conn.state === 'connected', 5000, 'reconnected after restart');
    await until(
      () => ircd.registrations.filter((r) => r.nick === 'lurk').length === 2,
      5000,
      'second registration',
    );
    const trail = stateEvents(managerEvents);
    expect(trail).not.toContain('reconnecting');
    const since = rows().slice(rowsBefore);
    // A fresh dial announces itself and reads the MOTD; nothing says "Reconnecting".
    expect(
      since.some((r) => r.type === 'notice' && (r.text ?? '').startsWith('Connecting to ')),
    ).toBe(true);
    expect(since.some((r) => (r.text ?? '').startsWith('Reconnecting in '))).toBe(false);
    expect(since.some((r) => r.type === 'error')).toBe(false);
    conn.join('#stay');
    await until(() => conn.isChannelJoined('#stay'), 5000, 'rejoined #stay');
  }, 20000);

  it('a disconnect during a link outage ends our side and does not come back when the link does', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    EngineLink.shared().simulateLoss();
    await until(() => conn.state !== 'connected', 5000, 'noticed the loss');
    ircManager.stopNetwork(userId, network.id, 'user clicked disconnect');
    expect(ircManager.getConnection(userId, network.id)).toBeNull();
    expect(conn.state).toBe('disconnected');
    await until(() => EngineLink.shared().state === 'ready', 5000, 'link back');
    // The close that could not leave during the outage goes out the moment the
    // link is back — before reconcile could adopt the socket — so nothing
    // resurrects it, and the next start is a fresh dial.
    await until(() => !engine.held().includes(engineId), 5000, 'deferred close delivered');
    expect(ircManager.getConnection(userId, network.id)).toBeNull();
    const registrationsBefore = ircd.registrations.length;
    const again = ircManager.startNetwork(userId, network.id)!;
    await until(() => again.state === 'connected', 5000, 'redialed after user disconnect');
    expect(ircd.registrations.length).toBe(registrationsBefore + 1);
    again.join('#stay');
    await until(() => again.isChannelJoined('#stay'), 5000, 'back in #stay');
  }, 20000);

  it('a held connection nobody autoconnects is adopted on boot; a paused account gets closed', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    // "Deploy": shutdown detaches, and a fresh process boots with a fresh link.
    ircManager.shutdown();
    expect(engine.held()).toContain(engineId);
    EngineLink.resetForTests();
    EngineLink.shared().start();
    await until(() => EngineLink.shared().state === 'ready', 5000, 'new link ready');
    managerEvents.length = 0;
    const rowsBefore = rows().length;
    // autoconnect is 0 on this network, so initAll starts nothing itself…
    expect(network.autoconnect).toBe(0);
    ircManager.initAll();
    // …and reconcile adopts what the engine kept.
    const adopted = ircManager.getConnection(userId, network.id);
    expect(adopted).not.toBeNull();
    await until(() => adopted!.state === 'connected', 5000, 'adopted connection attached');
    expect(
      rows()
        .slice(rowsBefore)
        .some((r) => (r.text ?? '').startsWith('Connecting to ')),
    ).toBe(false);

    // Same again, but the account is paused now: policy says close, not adopt.
    ircManager.shutdown();
    expect(engine.held()).toContain(engineId);
    setUserPaused(userId, true);
    try {
      EngineLink.resetForTests();
      EngineLink.shared().start();
      await until(() => EngineLink.shared().state === 'ready', 5000, 'link ready again');
      ircManager.initAll();
      expect(ircManager.getConnection(userId, network.id)).toBeNull();
      await until(
        () => !engine.held().includes(engineId),
        5000,
        "engine closed the paused account's socket",
      );
      await until(() => ircd.client('lurk') === undefined, 5000, 'ircd saw it go');
    } finally {
      setUserPaused(userId, false);
    }
    // Leave a live connection behind for the last test.
    const fresh = ircManager.startNetwork(userId, network.id)!;
    await until(() => fresh.state === 'connected', 5000, 'fresh connection for the next test');
  }, 30000);

  // #894: the hello lists what no other link claims, and a link the engine has
  // not yet seen die still claims what it held. Nothing re-listed those — a
  // session left that way sat unadopted, or for a paused account un-closed,
  // until the orphan reaper. The engine now offers it the moment the old link
  // is gone. The corpse here is a bare link that attached and then died
  // without a word, which is what a crashed process looks like to the engine.
  it('a session released after hello is adopted, or closed, without a restart (#894)', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    const corpse = async (): Promise<TestLink> => {
      const c = await TestLink.connect(EngineLink.shared().opts.port, SECRET, {
        instance: instanceId(),
      });
      c.send({
        op: 'connect',
        id: engineId,
        host: '127.0.0.1',
        port: ircd.port,
        tls: false,
        rejectUnauthorized: false,
      });
      await c.waitFor((f) => f.op === 'attached' && f.id === engineId);
      return c;
    };
    ircManager.shutdown();
    await until(() => engine.held().includes(engineId), 5000, 'engine holds the detached socket');
    let c = await corpse();
    EngineLink.resetForTests();
    EngineLink.shared().start();
    await until(() => EngineLink.shared().state === 'ready', 5000, 'new link ready');
    // Strict at hello, as before.
    expect(EngineLink.shared().held).not.toContain(engineId);
    const rowsBefore = rows().length;
    const registrations = ircd.registrations.filter((r) => r.nick === 'lurk').length;
    ircManager.initAll();
    expect(ircManager.getConnection(userId, network.id)).toBeNull();
    c.kill();
    await until(
      () => ircManager.getConnection(userId, network.id)?.state === 'connected',
      5000,
      'adopted once the corpse was gone',
    );
    // An attach, not a dial: no "Connecting…", no second registration.
    expect(
      rows()
        .slice(rowsBefore)
        .some((r) => (r.text ?? '').startsWith('Connecting to ')),
    ).toBe(false);
    expect(ircd.registrations.filter((r) => r.nick === 'lurk')).toHaveLength(registrations);

    // Same again, paused: the offer ends in a close.
    ircManager.shutdown();
    await until(() => engine.held().includes(engineId), 5000, 'engine holds it again');
    c = await corpse();
    setUserPaused(userId, true);
    try {
      EngineLink.resetForTests();
      EngineLink.shared().start();
      await until(() => EngineLink.shared().state === 'ready', 5000, 'link ready again');
      ircManager.initAll();
      expect(ircManager.getConnection(userId, network.id)).toBeNull();
      c.kill();
      await until(
        () => !engine.held().includes(engineId),
        5000,
        "engine closed the paused account's socket",
      );
      await until(() => ircd.client('lurk') === undefined, 5000, 'ircd saw it go');
    } finally {
      setUserPaused(userId, false);
    }
    // Leave a live connection behind for the next test.
    const fresh = ircManager.startNetwork(userId, network.id)!;
    await until(() => fresh.state === 'connected', 5000, 'fresh connection for the next test');
  }, 30000);

  it('a buffer closed while the link was down is PARTed on re-attach, not re-armed', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    conn.join('#leaving');
    await until(() => conn.isChannelJoined('#leaving'), 5000, 'joined #leaving');
    EngineLink.shared().simulateLoss();
    await until(() => conn.state !== 'connected', 5000, 'noticed the loss');
    // The user closes the buffer while cut off: autojoin drops, the PART is
    // silently lost by irc-framework's disconnected write().
    ircManager.partChannel(userId, network.id, '#leaving');
    await until(() => conn.state === 'connected', 8000, 'reattached');
    await until(() => !ircd.client('lurk')!.channels.has('#leaving'), 5000, 'the late PART landed');
    // The app's own view settles one hop later than the ircd's: the loss can
    // cut in before the join's 353/366 were read, and those replay from the
    // engine backlog AFTER the synthesised JOIN was answered with the PART —
    // upsertChannel puts the channel back until the PART's echo takes it out.
    await until(() => !conn.isChannelJoined('#leaving'), 5000, 'the app saw its PART');
    expect(conn.isChannelJoined('#stay')).toBe(true);
  }, 20000);

  // #1149: the outbound queue. Lines waiting when the app↔engine link drops
  // are held for the socket, which the engine still has, and go out in order
  // on re-attach. Lines waiting when the socket itself dies go with it, and
  // the buffer they were for says so.
  it('holds queued lines across a link loss, and reports those dropped with the socket', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    process.env.LURKER_SEND_PACING = '1';
    try {
      const bursts = (from: number) =>
        sentBy('lurk')
          .slice(from)
          .filter((l) => l.includes('burst '))
          .map((l) => l.slice(l.indexOf('burst ')));
      const sentBefore = sentBy('lurk').length;
      // Five short lines fill the 10 s budget; the next two wait their turn.
      for (let i = 0; i < 7; i++) ircManager.send(userId, network.id, '#stay', `burst ${i}`);
      await until(() => bursts(sentBefore).length >= 5, 5000, 'the burst went');
      expect(bursts(sentBefore).length).toBeLessThan(7);
      const atLoss = sentBy('lurk').length;
      EngineLink.shared().simulateLoss();
      await until(() => conn.state !== 'connected', 5000, 'noticed the loss');
      await until(() => conn.state === 'connected', 8000, 'reattached');
      await until(() => bursts(sentBefore).length === 7, 8000, 'the held lines went');
      expect(bursts(sentBefore)).toEqual(Array.from({ length: 7 }, (_, i) => `burst ${i}`));
      // Ahead of the re-attach's presence bookkeeping: MONITOR waits in the
      // low lane (sendPacer.ts). With it in high, the chat waited 16 s here.
      const after = () => sentBy('lurk').slice(atLoss);
      await until(
        () => after().some((l) => l.startsWith('MONITOR ')),
        8000,
        'the presence list was rebuilt',
      );
      const monitor = after().findIndex((l) => l.startsWith('MONITOR '));
      expect(after().findIndex((l) => l.includes('burst 5'))).toBeLessThan(monitor);

      // The socket dies with lines waiting: the engine dials again, and what
      // waited is dropped and reported where it was going.
      const rowsBefore = rows().length;
      for (let i = 0; i < 8; i++) ircManager.send(userId, network.id, '#stay', `again ${i}`);
      ircd.drop('lurk');
      await until(
        () =>
          rows()
            .slice(rowsBefore)
            .some(
              (r) =>
                r.type === 'error' && !!r.text?.startsWith('not sent (connection dropped): again '),
            ),
        15000,
        'the dropped lines were reported',
      );
      await until(() => conn.state === 'connected', 15000, 'registered on the new socket');
    } finally {
      process.env.LURKER_SEND_PACING = '0';
    }
  }, 60000);

  // The window Copilot's review on #829 pointed at: reconcileEngine checks the
  // link is ready at the top of its loop, but the link can die inside it. A
  // bare send() would drop the close on the floor and the paused account would
  // stay on IRC until something else happened to reconcile again.
  //
  // simulateLoss() destroys the socket synchronously while `state` is still
  // 'ready', which is exactly that window, and nothing here calls initAll(), so
  // no second reconcile on the next 'ready' can paper over a lost close.
  it('a reconcile close issued as the link dies is queued, not lost', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    // Detach, so the engine holds the socket with no live transport in the way.
    ircManager.shutdown();
    await until(() => engine.held().includes(engineId), 5000, 'engine holds the detached socket');

    setUserPaused(userId, true);
    try {
      EngineLink.resetForTests();
      const link = EngineLink.shared();
      link.start();
      await until(() => link.state === 'ready', 5000, 'link ready');
      expect(link.held).toContain(engineId);

      link.simulateLoss();
      expect(link.state).toBe('ready'); // the control: still inside the window
      ircManager.reconcileEngine();

      await until(() => link.state === 'ready', 8000, 'link back');
      await until(
        () => !engine.held().includes(engineId),
        8000,
        'the queued close reached the engine',
      );
      await until(() => ircd.client('lurk') === undefined, 5000, 'ircd saw it go');
    } finally {
      setUserPaused(userId, false);
    }
    // Leave a live connection behind for the last test.
    const fresh = ircManager.startNetwork(userId, network.id)!;
    await until(() => fresh.state === 'connected', 8000, 'fresh connection for the next test');
  }, 30000);

  // The app half of the instance partition. The engine refuses cross-instance
  // work (server/engine/engine.test.ts), but the id has to carry the namespace
  // in the first place, and reconciliation has to refuse to parse a foreign one
  // into this database's rowids.
  it('namespaces connection ids by instance and never adopts a foreign one', async () => {
    // Not `1:1` — the bare rowid pair every other Lurker would also mint.
    expect(engineId).toMatch(/^[0-9a-f]{32}:\d+:\d+$/);
    expect(engineId.endsWith(`:${userId}:${network.id}`)).toBe(true);
    expect(isOurConnectionId(engineId)).toBe(true);

    // Same rowids, different database.
    const foreign = `${'f'.repeat(32)}:${userId}:${network.id}`;
    expect(isOurConnectionId(foreign)).toBe(false);

    // A foreign id in the held list must not be parsed into our rowids and
    // adopted (or closed) as though it named one of our networks.
    const link = EngineLink.shared();
    const heldSet = (link as unknown as { heldSet: Set<string> }).heldSet;
    heldSet.add(foreign);
    try {
      const before = ircManager.getConnection(userId, network.id);
      ircManager.reconcileEngine();
      // Untouched: not adopted, and still on the engine's books as far as we
      // are concerned — we simply have no business with it.
      expect(ircManager.getConnection(userId, network.id)).toBe(before);
      expect(heldSet.has(foreign)).toBe(true);
    } finally {
      heldSet.delete(foreign);
    }
  });

  // #888: the engine holds sockets across deploys, so a cap a new app version
  // starts asking for would otherwise wait for the user's next real reconnect.
  it('a newer app negotiates a cap on the held socket, and the engine keeps it', async () => {
    const CAP = 'draft/channel-rename';
    const conn = ircManager.getConnection(userId, network.id)!;
    expect(conn.state).toBe('connected');
    // Advertised all along, wanted by nobody: this socket registered without it.
    expect(conn.client.network.cap.enabled).not.toContain(CAP);
    const registrations = ircd.registrations.filter((r) => r.nick === 'lurk').length;

    // "Deploy": the app goes away and the one that replaces it wants one more
    // cap than the socket ever negotiated.
    ircManager.shutdown();
    await until(() => engine.held().includes(engineId), 5000, 'engine holds it');
    const next = new IrcConnection({ network, onEvent: () => {} });
    next.client.requestCap(CAP);
    next.connect();
    await until(() => next.state === 'connected', 8000, 'reattached');
    await until(
      () => next.client.network.cap.enabled.includes(CAP),
      8000,
      'the cap was REQd and ACKed on the held socket',
    );
    expect(ircd.client('lurk')!.caps.has(CAP)).toBe(true);
    // Negotiated on the socket it already had — not by reconnecting.
    expect(ircd.registrations.filter((r) => r.nick === 'lurk')).toHaveLength(registrations);

    // And it sticks: a third app that never asks for it still finds it on,
    // because the engine recorded the live ACK and the replay carries it.
    next.detach();
    await until(() => next.state === 'disconnected', 5000, 'detached');
    const third = new IrcConnection({ network, onEvent: () => {} });
    third.connect();
    await until(() => third.state === 'connected', 8000, 'reattached again');
    expect(third.client.request_extra_caps).not.toContain(CAP);
    expect(third.client.network.cap.enabled).toContain(CAP);
    third.detach();
    await until(() => third.state === 'disconnected', 5000, 'detached again');

    // Leave a live connection behind for the last test.
    const fresh = ircManager.startNetwork(userId, network.id)!;
    await until(() => fresh.state === 'connected', 8000, 'fresh connection for the next test');
  }, 30000);

  it('takes a NAK for an answer instead of re-asking on every re-attach (#888)', async () => {
    ircManager.shutdown();
    await until(() => engine.held().includes(engineId), 5000, 'engine holds it');
    const conn = new IrcConnection({ network, onEvent: () => {} });
    conn.client.requestCap('draft/refused');
    // Asked for in the same restore. A REQ is all-or-nothing, so batching the
    // two would have the server NAK both and put this one in the refusal set
    // for good, though it would grant it on its own.
    conn.client.requestCap('draft/granted');
    conn.connect();
    await until(() => conn.state === 'connected', 8000, 'reattached');
    await until(
      () => sentBy('lurk').includes('CAP REQ :draft/refused'),
      5000,
      'asked for the cap once',
    );
    await until(
      () => conn.client.network.cap.enabled.includes('draft/granted'),
      5000,
      'the grantable one was granted',
    );
    // Advertised, so it stays in `available` and out of `enabled` for the life
    // of the socket — the shape that would otherwise ask again forever.
    expect(conn.client.network.cap.available.has('draft/refused')).toBe(true);
    expect(conn.client.network.cap.enabled).not.toContain('draft/refused');
    const asked = () => sentBy('lurk').filter((l) => l.startsWith('CAP REQ')).length;
    const before = asked();

    // A link blip is a re-attach of this same connection object — the case that
    // repeats most often, and the one the refusal set has to survive.
    EngineLink.shared().simulateLoss();
    await until(() => conn.state !== 'connected', 5000, 'noticed the loss');
    await until(() => conn.state === 'connected', 8000, 'reattached again');
    // Bound the negative on the wire: anything the restore sent is ahead of
    // this on the same ordered socket.
    conn.raw('PING capbound');
    await until(() => sentBy('lurk').includes('PING capbound'), 5000, 'the bound landed');
    expect(asked()).toBe(before);

    conn.detach();
    await until(() => conn.state === 'disconnected', 5000, 'detached');
    // Leave a live connection behind for the last test.
    const fresh = ircManager.startNetwork(userId, network.id)!;
    await until(() => fresh.state === 'connected', 8000, 'fresh connection for the next test');
  }, 30000);

  it('ircManager.shutdown() detaches; dispose still QUITs', async () => {
    ircManager.shutdown();
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.held()).toContain(engineId);
    expect(ircd.client('lurk')).toBeDefined();
    expect(sentBy('lurk').some((l) => l.startsWith('QUIT'))).toBe(false);

    const conn = ircManager.startNetwork(userId, network.id)!;
    await until(() => conn.state === 'connected', 5000, 'reattached after shutdown');
    // Hold the record: once the socket is gone, client() no longer finds it.
    const record = ircd.client('lurk')!;
    ircManager.disposeNetwork(userId, network.id, 'removed in test');
    await until(() => !engine.held().includes(engineId), 5000, 'engine released the socket');
    expect(record.sent.some((l) => l === 'QUIT :removed in test')).toBe(true);
    await until(() => ircd.client('lurk') === undefined, 5000, 'ircd saw the quit');
  }, 20000);
});
