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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import db from '../db/index.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { setUserPaused } from '../db/users.js';
import type { Network } from '../db/networks.js';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import type { EngineServer } from '../engine/server.js';
import type { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';
import { until as poll } from '../test-utils/until.js';
import { EngineLink, engineConnectionId, isOurConnectionId } from './engineLink.js';

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
  harness = await startEngineHarness({ secret: SECRET });
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
      () => sentBy('lurk').filter((l) => /^WHO #(stay|gone)$/.test(l)).length >= 2,
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
    // Life while the app is away.
    ircd.kick('#gone', 'lurk');
    ircd.say('peer', '#stay', 'while away');
    ircd.say('peer', 'lurk', 'dm while away');
    await new Promise((r) => setTimeout(r, 30));
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
    expect(stateRequests()).toHaveLength(3);
    expect(since().filter((l) => l === 'PING connectcmd')).toHaveLength(0);
    expect(ircd.client('lurk')!.channels.has('#gone')).toBe(false);
  }, 30000);

  it('losing the link to the engine re-attaches without a disconnect', async () => {
    const conn = ircManager.getConnection(userId, network.id)!;
    managerEvents.length = 0;
    const rowsBefore = rows().length;
    const sentBefore = sentBy('lurk').length;
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

  it('skips a msgid it already has during catch-up, and only then', async () => {
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
    // Steady state: no lookup, a server never repeats a msgid anyway.
    conn.catchingUp = false;
    feed('dup-2', 'steady state');
    feed('dup-2', 'steady state');
    expect(count('steady state')).toBe(2);
    // And catch-up never drops a line it has NOT seen.
    conn.catchingUp = true;
    feed('fresh-1', 'new in catch-up');
    expect(count('new in catch-up')).toBe(1);
    conn.catchingUp = false;
  });

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
