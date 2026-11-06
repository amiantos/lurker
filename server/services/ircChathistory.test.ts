// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The history gap-fill on the wire (#1283): a socket drops, people keep
// talking, the reconnect's JOIN asks the network for what was missed, and the
// lines land once, at their own times, as what they are. Also what a network
// pushes unasked (ergo's replay at JOIN, ZNC's playback at attach) now that it
// is no longer dropped whole.

import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import db from '../db/index.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { FakeIrcd, rawClient } from '../test-utils/fakeIrcd.js';
import type { FakeIrcdOptions } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';
import { ReplyRouter } from './replyRouter.js';

type Ev = Record<string, unknown>;
let ircManager: typeof import('./ircManager.js').default;
let userId: number;
let seq = 0;

interface Row {
  id: number;
  type: string;
  nick: string | null;
  text: string | null;
  time: string;
  msgid: string | null;
}

const rowsFor = (networkId: number, target: string): Row[] =>
  db
    .prepare(
      `SELECT m.id, m.type, m.nick, m.text, m.time, m.msgid FROM messages m
       JOIN buffers b ON b.id = m.buffer_id
       WHERE b.network_id = ? AND b.target_folded = ? AND m.type IN ('message', 'action', 'notice')
       ORDER BY m.id`,
    )
    .all(networkId, target.toLowerCase()) as Row[];

const texts = (networkId: number, target: string) => rowsFor(networkId, target).map((r) => r.text);

const reactionsOn = (messageId: number) =>
  db
    .prepare('SELECT nick, value FROM message_reactions WHERE message_id = ? ORDER BY id')
    .all(messageId) as Array<{ nick: string; value: string }>;

beforeAll(async () => {
  process.env.LURKER_RECONNECT_BASE_MS = '50';
  process.env.LURKER_RECONNECT_JITTER_MS = '1';
  ircManager = (await import('./ircManager.js')).default;
  userId = createUser('chathistory').id;
});

afterAll(() => {
  delete process.env.LURKER_RECONNECT_BASE_MS;
  delete process.env.LURKER_RECONNECT_JITTER_MS;
});

// A network on `ircd`, started through the manager (whose rejoin at
// registration is what brings the JOIN after a reconnect), with its events.
function start(ircd: FakeIrcd, nick: string) {
  const network: Network = createNetwork(userId, {
    name: `hist-${seq++}`,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  })!;
  const events: Ev[] = [];
  const onEvent = (e: Ev) => {
    if (e.networkId === network.id) events.push(e);
  };
  ircManager.on('event', onEvent);
  const conn = ircManager.startNetwork(userId, network.id)!;
  const stop = () => {
    ircManager.off('event', onEvent);
    ircManager.stopNetwork(userId, network.id);
  };
  return { network, conn, events, stop };
}

const chathistoryCommands = (ircd: FakeIrcd, nick: string) =>
  (ircd.client(nick)?.sent ?? []).filter((l) => l.startsWith('CHATHISTORY '));

// Drop the socket and wait for the manager's reconnect to have us back in
// `channel` on a fresh registration.
async function dropAndRejoin(
  ircd: FakeIrcd,
  nick: string,
  conn: { isChannelJoined(c: string): boolean },
  channel: string,
) {
  const registrations = ircd.registrations.length;
  ircd.drop(nick, false);
  await until(() => !conn.isChannelJoined(channel), 5000, 'parted by the drop');
  await until(
    () => ircd.registrations.length > registrations && conn.isChannelJoined(channel),
    20000,
    `rejoined ${channel}`,
  );
}

const tick = () => new Promise((r) => setTimeout(r, 5));
// `s` seconds past an hour ago, as an IRC timestamp.
const ago = (s: number) => new Date(Date.now() - 3_600_000 + s * 1000).toISOString();

describe('a gap filled from the network’s history', () => {
  let ircd: FakeIrcd;
  // A page of two, so a three-line gap takes two requests.
  const opts: FakeIrcdOptions = { chathistory: { limit: 2 } };
  beforeAll(async () => {
    ircd = await FakeIrcd.start(opts);
  });
  afterAll(async () => {
    await ircd.close();
  });

  it('asks BETWEEN the last line it holds and the rejoin, pages, and stores the gap once with its own times', async () => {
    const nick = 'gapone';
    const { network, conn, events, stop } = start(ircd, nick);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      ircManager.joinChannel(userId, network.id, '#gap');
      await until(() => conn.isChannelJoined('#gap'), 5000, 'joined #gap');
      ircd.say('peer', '#gap', 'before the drop');
      await until(() => texts(network.id, '#gap').length === 1, 5000, 'the live line stored');
      // What the requests are sent with: the server's replies pace the walk,
      // so the flood clock must not (sendPacer, `unpaced`). On the
      // prototype: the reconnect builds the socket's router anew.
      const sent = vi.spyOn(ReplyRouter.prototype, 'send');

      await tick();
      ircd.drop(nick, false);
      await until(() => !conn.isChannelJoined('#gap'), 5000, 'parted by the drop');
      // Said while nobody was there to hear it: the gap.
      ircd.say('peer', '#gap', 'gap one');
      await tick();
      ircd.say('peer', '#gap', 'gap two');
      await tick();
      ircd.say('other', '#gap', 'gap three');
      const gapTimes = ircd.history
        .get('#gap')!
        .slice(1)
        .map((l) => l.time);
      await tick();

      const registrations = ircd.registrations.length;
      await until(
        () => ircd.registrations.length > registrations && conn.isChannelJoined('#gap'),
        20000,
        'rejoined #gap',
      );
      await until(
        () => texts(network.id, '#gap').length === 4,
        5000,
        'the gap filled',
        () => JSON.stringify(texts(network.id, '#gap')),
      );
      // A little longer: nothing more arrives, nothing twice.
      await new Promise((r) => setTimeout(r, 200));
      const rows = rowsFor(network.id, '#gap');
      expect(rows.map((r) => r.text)).toEqual([
        'before the drop',
        'gap one',
        'gap two',
        'gap three',
      ]);
      // Their own times, not the time they were fetched.
      expect(rows.slice(1).map((r) => r.time)).toEqual(gapTimes);
      // Pages of two, each starting a millisecond under the newest line of
      // the last (so a second line in that millisecond is not skipped): the
      // window holds the anchor line and the three missed, so four pages, the
      // last short. The overlap is one line a page, and the dedupe ate it.
      const asked = chathistoryCommands(ircd, nick).filter((l) => l.includes(' #gap '));
      expect(asked).toHaveLength(4);
      expect(asked[0]).toMatch(/^CHATHISTORY BETWEEN #gap timestamp=\S+ timestamp=\S+ 2$/);
      const bounds = asked.map((l) => /timestamp=(\S+) timestamp=(\S+)/.exec(l)!);
      expect(new Set(bounds.map((b) => b[2])).size).toBe(1);
      for (let i = 1; i < bounds.length; i++) expect(bounds[i][1] > bounds[i - 1][1]).toBe(true);
      const requests = sent.mock.calls.filter(
        ([, line]) => typeof line === 'string' && line.startsWith('CHATHISTORY '),
      );
      expect(requests.length).toBeGreaterThanOrEqual(4);
      for (const [, , , opts] of requests) {
        expect((opts as { unpaced?: boolean } | undefined)?.unpaced).toBe(true);
      }
      sent.mockRestore();
      // The frames said what they were: replayed, so no toast or push.
      const replayed = events.filter((e) => e.type === 'message' && e.replay === true);
      expect(replayed.map((e) => e.text)).toEqual(['gap one', 'gap two', 'gap three']);
      const live = events.find((e) => e.type === 'message' && e.text === 'before the drop');
      expect(live?.replay).toBeUndefined();
    } finally {
      stop();
    }
  }, 30000);

  it('a DM that had a line in the gap is found by TARGETS and filled; a reaction in the gap lands', async () => {
    const nick = 'gaptwo';
    const { network, conn, stop } = start(ircd, nick);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      ircManager.joinChannel(userId, network.id, '#dmgap');
      await until(() => conn.isChannelJoined('#dmgap'), 5000, 'joined');
      // A DM before the drop, so the conversation has an anchor of its own.
      ircd.say('friend', nick, 'hello before');
      ircd.say('peer', '#dmgap', 'chat before');
      await until(() => texts(network.id, 'friend').length === 1, 5000, 'the DM stored');
      await until(() => texts(network.id, '#dmgap').length === 1, 5000, 'the chat stored');

      await tick();
      ircd.drop(nick, false);
      await until(() => !conn.isChannelJoined('#dmgap'), 5000, 'parted by the drop');
      ircd.say('friend', nick, 'missed you');
      await tick();
      // Someone new writes for the first time while we are away.
      ircd.say('stranger', nick, 'are you there');
      await tick();
      const target = ircd.say('peer', '#dmgap', 'react to this');
      await tick();
      ircd.tagmsg('other', '#dmgap', [`+draft/react=👍`, `+reply=${target}`]);
      await tick();

      const registrations = ircd.registrations.length;
      await until(
        () => ircd.registrations.length > registrations && conn.isChannelJoined('#dmgap'),
        20000,
        'rejoined',
      );
      await until(
        () =>
          texts(network.id, 'friend').length === 2 &&
          texts(network.id, 'stranger').length === 1 &&
          texts(network.id, '#dmgap').length === 2,
        5000,
        'DMs and channel filled',
        () =>
          JSON.stringify({
            friend: texts(network.id, 'friend'),
            stranger: texts(network.id, 'stranger'),
            chan: texts(network.id, '#dmgap'),
            asked: chathistoryCommands(ircd, nick),
          }),
      );
      await new Promise((r) => setTimeout(r, 200));
      expect(texts(network.id, 'friend')).toEqual(['hello before', 'missed you']);
      expect(texts(network.id, 'stranger')).toEqual(['are you there']);
      const reacted = rowsFor(network.id, '#dmgap').find((r) => r.text === 'react to this')!;
      expect(reactionsOn(reacted.id)).toEqual([{ nick: 'other', value: '👍' }]);
      const asked = chathistoryCommands(ircd, nick);
      // Three conversations had a line, at a page of two: TARGETS pages too.
      expect(
        asked.filter((l) => l.startsWith('CHATHISTORY TARGETS ')).length,
      ).toBeGreaterThanOrEqual(1);
      // Each conversation got its own window (pages of two, so a window that
      // holds its anchor line and one missed takes two); the channel was the
      // JOIN's, not the TARGETS'.
      expect(asked.filter((l) => l.includes(' stranger '))).toHaveLength(1);
      expect(asked.filter((l) => l.includes(' friend ')).length).toBeGreaterThanOrEqual(1);
      expect(asked.filter((l) => l.includes(' #dmgap ')).length).toBeGreaterThanOrEqual(1);
      // TARGETS goes at the MOTD, ahead of the rejoin's JOIN; the DM windows
      // it names come after it.
      const order = asked.map((l) => (l.split(' ')[1] === 'TARGETS' ? 'TARGETS' : l.split(' ')[2]));
      expect(order[0]).toBe('TARGETS');
      expect(order.indexOf('TARGETS')).toBeLessThan(order.indexOf('friend'));
    } finally {
      stop();
    }
  }, 30000);

  it('asks nothing for a channel it has no history of, and nothing at the first registration', async () => {
    const nick = 'gapthree';
    const { network, conn, stop } = start(ircd, nick);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      await until(() => conn.isupportComplete, 5000, 'motd');
      ircManager.joinChannel(userId, network.id, '#fresh');
      await until(() => conn.isChannelJoined('#fresh'), 5000, 'joined');
      await new Promise((r) => setTimeout(r, 200));
      expect(chathistoryCommands(ircd, nick)).toEqual([]);
      expect(texts(network.id, '#fresh')).toEqual([]);
    } finally {
      stop();
    }
  }, 15000);

  it('ZNC’s playback at attach lands once, and again after a reconnect lands nothing', async () => {
    const nick = 'zncone';
    const { network, conn, stop } = start(ircd, nick);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      ircManager.joinChannel(userId, network.id, '#znc');
      await until(() => conn.isChannelJoined('#znc'), 5000, 'joined');
      // An hour ago: ZNC's buffer is the past (a stamp in the future would be
      // clamped to receive time, MAX_FUTURE_TIME_SKEW_MS).
      const buffer = [
        { time: ago(0), line: ':alice!~a@znc PRIVMSG #znc :first' },
        { time: ago(1), line: ':bob!~b@znc PRIVMSG #znc :second' },
      ];
      ircd.zncPlayback(nick, '#znc', buffer);
      await until(() => texts(network.id, '#znc').length === 2, 5000, 'playback stored');
      expect(rowsFor(network.id, '#znc').map((r) => [r.text, r.time, r.msgid])).toEqual([
        ['first', buffer[0].time, null],
        ['second', buffer[1].time, null],
      ]);

      await dropAndRejoin(ircd, nick, conn, '#znc');
      ircd.zncPlayback(nick, '#znc', [
        ...buffer,
        { time: ago(2), line: ':bob!~b@znc PRIVMSG #znc :third' },
      ]);
      await until(() => texts(network.id, '#znc').length === 3, 5000, 'the new line stored');
      await new Promise((r) => setTimeout(r, 200));
      expect(texts(network.id, '#znc')).toEqual(['first', 'second', 'third']);
    } finally {
      stop();
    }
  }, 30000);
});

describe('the events inside a filled gap', () => {
  let ircd: FakeIrcd;
  // A network that keeps joins, parts, quits and topics in a channel's
  // history, as ergo does, and offers draft/event-playback.
  beforeAll(async () => {
    ircd = await FakeIrcd.start({ chathistory: { events: true } });
  });
  afterAll(async () => {
    await ircd.close();
  });

  type Peer = Awaited<ReturnType<typeof rawClient>>;
  const inChannel = (nick: string, channel: string) =>
    ircd.client(nick)?.channels.has(channel) ?? false;

  it('come as the lines they were and land as rows, ours left out, with membership what the NAMES said', async () => {
    const nick = 'evone';
    const { network, conn, events, stop } = start(ircd, nick);
    const peers: Peer[] = [];
    const peer = async (name: string) => {
      const p = await rawClient(ircd.port, name);
      peers.push(p);
      return p;
    };
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      let stay = await peer('stay');
      stay.send('JOIN #ev');
      await until(() => inChannel('stay', '#ev'), 5000, 'stay in #ev');
      ircManager.joinChannel(userId, network.id, '#ev');
      await until(
        () => conn.channelState('#ev')?.members.has('stay') ?? false,
        5000,
        'joined #ev, stay there',
      );
      ircd.say('peer', '#ev', 'before');
      await until(() => texts(network.id, '#ev').length === 1, 5000, 'the live line stored');

      await tick();
      const dropAt = new Date().toISOString();
      ircd.drop(nick, false);
      await until(() => !conn.isChannelJoined('#ev'), 5000, 'parted by the drop');
      // The gap, every step of it in the history: one arrives, steps out and
      // comes back; one looks in and leaves; one drops and returns; the
      // topic changes; a line is said.
      const arrive = await peer('arrive');
      arrive.send('JOIN #ev');
      await until(() => inChannel('arrive', '#ev'), 5000, 'arrive in');
      arrive.send('PART #ev :brb');
      await until(() => !inChannel('arrive', '#ev'), 5000, 'arrive out');
      arrive.send('JOIN #ev');
      await until(() => inChannel('arrive', '#ev'), 5000, 'arrive back');
      const leaver = await peer('leaver');
      leaver.send('JOIN #ev');
      await until(() => inChannel('leaver', '#ev'), 5000, 'leaver in');
      leaver.send('PART #ev :bye');
      await until(() => !inChannel('leaver', '#ev'), 5000, 'leaver out');
      stay.socket.destroy();
      await until(() => !ircd.client('stay'), 5000, 'stay gone');
      stay = await peer('stay');
      stay.send('JOIN #ev');
      await until(() => inChannel('stay', '#ev'), 5000, 'stay back');
      ircd.setTopic('arrive', '#ev', 'set while nobody was home');
      ircd.say('arrive', '#ev', 'arrived');
      await tick();
      const kept = ircd.history.get('#ev')!;
      expect(kept.filter((l) => l.histserv !== undefined).length).toBeGreaterThanOrEqual(8);

      const registrations = ircd.registrations.length;
      await until(
        () => ircd.registrations.length > registrations && conn.isChannelJoined('#ev'),
        20000,
        'rejoined #ev',
      );
      await until(
        () => texts(network.id, '#ev').length === 2,
        5000,
        'the gap filled',
        () => JSON.stringify(texts(network.id, '#ev')),
      );
      await new Promise((r) => setTimeout(r, 300));
      // The conversation, and nothing from HistServ: the page carried the
      // events as JOIN, PART, QUIT and TOPIC lines, not as chat about them.
      expect(ircd.client(nick)?.caps.has('draft/event-playback')).toBe(true);
      expect(texts(network.id, '#ev')).toEqual(['before', 'arrived']);
      expect(rowsFor(network.id, '#ev').some((r) => r.nick === 'HistServ')).toBe(false);
      // Membership is the rejoin's NAMES: a replayed PART would have dropped
      // arrive, a replayed QUIT stay, a replayed JOIN added leaver.
      const members = conn.channelState('#ev')!.members;
      expect([...members.keys()].toSorted()).toEqual(['arrive', 'evone', 'stay']);
      expect(conn.channelState('#ev')!.topic).toBe('set while nobody was home');
      // And every one of them is a row, at its time, as if we had been there
      // — all but our own: the rejoin's JOIN is written live, and our QUIT
      // before it is the outage. (The window opens a second before the last
      // line held, so stay's first JOIN may be in it too; the gap is what is
      // asserted.)
      const eventRows = (
        db
          .prepare(
            `SELECT m.nick, m.type, m.text, m.time FROM messages m JOIN buffers b ON b.id = m.buffer_id
             WHERE b.network_id = ? AND b.target_folded = '#ev'
               AND m.type IN ('join', 'part', 'quit', 'nick', 'topic', 'kick')
             ORDER BY m.time, m.id`,
          )
          .all(network.id) as Array<{
          nick: string;
          type: string;
          text: string | null;
          time: string;
        }>
      ).filter((r) => r.time >= dropAt);
      expect(eventRows.filter((r) => r.nick !== nick).map((r) => `${r.type}:${r.nick}`)).toEqual([
        'join:arrive',
        'part:arrive',
        'join:arrive',
        'join:leaver',
        'part:leaver',
        'quit:stay',
        'join:stay',
        'topic:arrive',
      ]);
      expect(eventRows.find((r) => r.type === 'part' && r.nick === 'leaver')?.text).toBe('bye');
      expect(eventRows.filter((r) => r.nick === nick).map((r) => r.type)).toEqual(['join']);
      // Replayed rows, so nothing toasted for them.
      const replayedEvents = events.filter(
        (e) => e.replay === true && e.type === 'join' && String(e.time) >= dropAt,
      );
      expect(replayedEvents.map((e) => e.nick)).toEqual(['arrive', 'arrive', 'leaver', 'stay']);
    } finally {
      for (const p of peers) p.socket.destroy();
      stop();
    }
  }, 30000);
});

describe('a network that replays at JOIN unasked (no cap taken)', () => {
  let ircd: FakeIrcd;
  beforeAll(async () => {
    ircd = await FakeIrcd.start({ chathistory: { autoreplay: 3, advertise: false } });
  });
  afterAll(async () => {
    await ircd.close();
  });

  it('is deduped line by line: what we had stays single, what we missed lands, a reaction does not', async () => {
    const nick = 'autoone';
    const { network, conn, stop } = start(ircd, nick);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      ircManager.joinChannel(userId, network.id, '#auto');
      await until(() => conn.isChannelJoined('#auto'), 5000, 'joined');
      ircd.say('peer', '#auto', 'seen live');
      await until(() => texts(network.id, '#auto').length === 1, 5000, 'stored');

      await tick();
      ircd.drop(nick, false);
      await until(() => !conn.isChannelJoined('#auto'), 5000, 'parted');
      const target = ircd.say('peer', '#auto', 'missed');
      await tick();
      ircd.tagmsg('other', '#auto', [`+draft/react=👍`, `+reply=${target}`]);
      await tick();

      const registrations = ircd.registrations.length;
      await until(
        () => ircd.registrations.length > registrations && conn.isChannelJoined('#auto'),
        20000,
        'rejoined',
      );
      await until(
        () => texts(network.id, '#auto').length === 2,
        5000,
        'the replay landed',
        () => JSON.stringify(texts(network.id, '#auto')),
      );
      await new Promise((r) => setTimeout(r, 200));
      expect(texts(network.id, '#auto')).toEqual(['seen live', 'missed']);
      const missed = rowsFor(network.id, '#auto').find((r) => r.text === 'missed')!;
      expect(reactionsOn(missed.id)).toEqual([]);
      expect(chathistoryCommands(ircd, nick)).toEqual([]);
    } finally {
      stop();
    }
  }, 30000);
});

describe('a network that refuses', () => {
  let ircd: FakeIrcd;
  beforeAll(async () => {
    ircd = await FakeIrcd.start({ chathistory: { fail: 'MESSAGE_ERROR' } });
  });
  afterAll(async () => {
    await ircd.close();
  });

  it('ends the walk on the FAIL, asks once per buffer, and the connection carries on', async () => {
    const nick = 'failone';
    const { network, conn, stop } = start(ircd, nick);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      ircManager.joinChannel(userId, network.id, '#no');
      await until(() => conn.isChannelJoined('#no'), 5000, 'joined');
      ircd.say('peer', '#no', 'before');
      await until(() => texts(network.id, '#no').length === 1, 5000, 'stored');
      await tick();
      ircd.drop(nick, false);
      await until(() => !conn.isChannelJoined('#no'), 5000, 'parted');
      ircd.say('peer', '#no', 'lost');
      await tick();
      const registrations = ircd.registrations.length;
      await until(
        () => ircd.registrations.length > registrations && conn.isChannelJoined('#no'),
        20000,
        'rejoined',
      );
      await until(() => chathistoryCommands(ircd, nick).length >= 1, 5000, 'asked');
      await new Promise((r) => setTimeout(r, 300));
      expect(chathistoryCommands(ircd, nick).filter((l) => l.includes(' #no '))).toHaveLength(1);
      expect(texts(network.id, '#no')).toEqual(['before']);
      expect(conn.state).toBe('connected');
      ircd.say('peer', '#no', 'after');
      await until(() => texts(network.id, '#no').length === 2, 5000, 'live again');
    } finally {
      stop();
    }
  }, 30000);
});

describe('a REDACT inside a history page', () => {
  let ircd: FakeIrcd;
  beforeAll(async () => {
    ircd = await FakeIrcd.start({ chathistory: { limit: 100 } });
  });
  afterAll(async () => {
    await ircd.close();
  });

  it('applies to the line the same page brought, once that line is stored', async () => {
    const nick = 'redacted';
    const { network, conn, stop } = start(ircd, nick);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      ircManager.joinChannel(userId, network.id, '#rd');
      await until(() => conn.isChannelJoined('#rd'), 5000, 'joined');
      const t = ago(0);
      // A page that holds a line and, after it, its deletion: a server that
      // keeps the deletion in history (soju) serves both.
      for (const line of [
        `:fake.test BATCH +o chathistory #rd`,
        `@batch=o;time=${t};msgid=rd1 :peer!~p@h PRIVMSG #rd :take this back`,
        `@batch=o;time=${ago(1)};msgid=rd2 :peer!~p@h PRIVMSG #rd :keep this`,
        `@batch=o;time=${ago(2)} :peer!~p@h REDACT #rd rd1 :oops`,
        `:fake.test BATCH -o`,
      ])
        ircd.sendRaw(nick, line);
      await until(() => rowsFor(network.id, '#rd').length === 2, 5000, 'the page stored');
      await until(
        () =>
          (
            db
              .prepare('SELECT redacted_at FROM messages WHERE msgid = ? AND network_id = ?')
              .get('rd1', network.id) as { redacted_at: string | null } | undefined
          )?.redacted_at != null,
        5000,
        'the deletion applied after the line',
      );
      const rows = rowsFor(network.id, '#rd');
      expect(rows.map((r) => [r.msgid, r.text])).toEqual([
        ['rd1', null],
        ['rd2', 'keep this'],
      ]);
    } finally {
      stop();
    }
  }, 15000);
});

describe('a multiline message inside a history page', () => {
  let ircd: FakeIrcd;
  beforeAll(async () => {
    ircd = await FakeIrcd.start({ chathistory: { limit: 100 } });
  });
  afterAll(async () => {
    await ircd.close();
  });

  // irc-framework hands a batch's lines to their handlers only when the batch
  // ends, and drops a line tagged with a batch it has not yet opened
  // (commands/handler.js, dispatch). A multiline message inside a history
  // page is a batch nested in a batch: its opening line waits for the page
  // to end, so its lines are dropped as they arrive. The message is lost —
  // before this it was lost with the whole page — and the page carries on.
  it('is lost by irc-framework, and the rest of the page still lands', async () => {
    const nick = 'nested';
    const { network, conn, events, stop } = start(ircd, nick);
    try {
      await until(() => conn.state === 'connected', 5000, 'connected');
      ircManager.joinChannel(userId, network.id, '#ml');
      await until(() => conn.isChannelJoined('#ml'), 5000, 'joined');
      const t = new Date(Date.now() - 60_000).toISOString();
      for (const line of [
        `:fake.test BATCH +o chathistory #ml`,
        `@batch=o;time=${t};msgid=mm1 :fake.test BATCH +i draft/multiline #ml`,
        `@batch=i :peer!~p@h PRIVMSG #ml :line one`,
        `@batch=i :peer!~p@h PRIVMSG #ml :line two`,
        `@batch=o :fake.test BATCH -i`,
        `@batch=o;time=${t};msgid=mm2 :peer!~p@h PRIVMSG #ml :plain after`,
        `:fake.test BATCH -o`,
      ])
        ircd.sendRaw(nick, line);
      await until(() => texts(network.id, '#ml').length >= 1, 5000, 'the plain line stored');
      await new Promise((r) => setTimeout(r, 300));
      expect(rowsFor(network.id, '#ml').map((r) => [r.text, r.msgid])).toEqual([
        ['plain after', 'mm2'],
      ]);
      const msgs = events.filter((e) => e.type === 'message');
      expect(msgs.map((e) => [e.text, e.replay])).toEqual([['plain after', true]]);
    } finally {
      stop();
    }
  }, 15000);
});
