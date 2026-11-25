// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 reactions (client-tags/react) end to end: a real IrcConnection over a
// real socket to the fake ircd, so the tags go through irc-framework's parser
// and unescaping exactly as they would from a network. What's asserted is what
// the user would see — the reactions a line carries when it's read back, the
// live frames, the reactions feed — plus what went out on the wire.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { insertMessage, listMessages } from '../db/messages.js';
import type { MessageEvent } from '../db/messages.js';
import { listReactionsToUser, reactionSendTarget } from '../db/reactions.js';
import { IrcConnection } from './ircConnection.js';
import ignoreRulesService from './ignoreRulesService.js';
import ircManager from './ircManager.js';
import { e2eManager } from './e2e/manager.js';
import { maskToRuleInput } from './ignoreRuleInput.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Ev = Record<string, unknown>;

let ircd: FakeIrcd;
let denyIrcd: FakeIrcd;
let draftDenyIrcd: FakeIrcd;
let unrealIrcd: FakeIrcd;
let userId: number;
let seq = 0;

beforeAll(async () => {
  ircd = await FakeIrcd.start();
  // A network that forbids every client-only tag.
  denyIrcd = await FakeIrcd.start({ isupport: ['CLIENTTAGDENY=*'] });
  // A network that allows the ratified reply tag but forbids the draft name.
  draftDenyIrcd = await FakeIrcd.start({ isupport: ['CLIENTTAGDENY=draft/reply'] });
  // irc.so's UnrealIRCd, verbatim (#1101): react and both reply names
  // allowed, draft/unreact not.
  unrealIrcd = await FakeIrcd.start({
    isupport: [
      'CLIENTTAGDENY=*,-draft/react,-draft/typing,-typing,-draft/channel-context,-draft/reply,-reply',
    ],
  });
  userId = createUser('reactions-int').id;
});

afterAll(async () => {
  await ircd.close();
  await denyIrcd.close();
  await draftDenyIrcd.close();
  await unrealIrcd.close();
});

function makeNetwork(nick: string, port = ircd.port): Network {
  return createNetwork(userId, {
    name: `react-${seq++}`,
    host: '127.0.0.1',
    port,
    tls: false,
    nick,
    autoconnect: false,
  })!;
}

interface Rig {
  conn: IrcConnection;
  events: Ev[];
  network: Network;
  nick: string;
}

// Connected, through the end of the registration burst (react-support is
// published once the MOTD closes it), and in `chan` if given.
async function connect(nick: string, chan?: string, port = ircd.port): Promise<Rig> {
  const network = makeNetwork(nick, port);
  const events: Ev[] = [];
  const conn = new IrcConnection({ network, onEvent: (e) => events.push(e as Ev) });
  conn.connect();
  await until(() => events.some((e) => e.type === 'react-support'), 5000, 'react-support');
  if (chan) {
    conn.client.join(chan);
    await until(
      () => events.some((e) => e.type === 'channel-joined' && e.target === chan),
      5000,
      `joined ${chan}`,
    );
  }
  return { conn, events, network, nick };
}

function rows(rig: Rig, target: string): MessageEvent[] {
  return listMessages(rig.network.id, target, { limit: 200 });
}

function rowByMsgid(rig: Rig, target: string, msgid: string): MessageEvent {
  const row = rows(rig, target).find((m) => m.msgid === msgid);
  if (!row) throw new Error(`no stored row with msgid ${msgid} in ${target}`);
  return row;
}

// A peer's line, stored — returns its msgid.
async function peerSays(rig: Rig, from: string, target: string, text: string): Promise<string> {
  const msgid = ircd.say(from, target, text);
  const where = target.startsWith('#') ? target : from;
  await until(() => rows(rig, where).some((m) => m.msgid === msgid), 5000, `stored "${text}"`);
  return msgid;
}

const reactionFrames = (rig: Rig) => rig.events.filter((e) => e.type === 'reaction');

// A negative assertion needs a barrier: a reaction the handler DOES record,
// sent after the one under test on the same socket. Once it's in, anything
// sent before it has been handled too. Each call uses a fresh value so it can
// never be satisfied by an earlier barrier.
let barrierSeq = 0;
async function barrier(rig: Rig, from: string, target: string, msgid: string): Promise<void> {
  const value = `probe${++barrierSeq}`;
  ircd.tagmsg(from, target, [`+draft/reply=${msgid}`, `+draft/react=${value}`]);
  await until(() => reactionFrames(rig).some((e) => e.value === value), 5000, `barrier ${value}`);
}

describe('receiving reactions', () => {
  it('puts a peer’s reaction on the line it replies to, and takes it off on unreact', async () => {
    const rig = await connect('recv1', '#r1');
    try {
      const msgid = await peerSays(rig, 'bob', '#r1', 'anyone tried the new build?');

      ircd.tagmsg('bob', '#r1', [`+draft/reply=${msgid}`, '+draft/react=👍']);
      await until(() => reactionFrames(rig).length === 1, 5000, 'reaction frame');

      const row = rowByMsgid(rig, '#r1', msgid);
      expect(row.reactions).toEqual([{ nick: 'bob', value: '👍', self: false }]);
      expect(reactionFrames(rig)[0]).toMatchObject({
        target: '#r1',
        messageId: row.id,
        bufferId: row.bufferId,
        nick: 'bob',
        value: '👍',
        self: false,
        remove: false,
        toSelf: false,
      });

      // The ratified `+reply` is read as well as the draft one.
      ircd.tagmsg('carol', '#r1', [`+reply=${msgid}`, '+draft/react=👍']);
      await until(() => reactionFrames(rig).length === 2, 5000, 'second reaction');
      expect(rowByMsgid(rig, '#r1', msgid).reactions).toEqual([
        { nick: 'bob', value: '👍', self: false },
        { nick: 'carol', value: '👍', self: false },
      ]);

      // Unreact matches the reactor case-insensitively.
      ircd.tagmsg('BOB', '#r1', [`+draft/reply=${msgid}`, '+draft/unreact=👍']);
      await until(() => reactionFrames(rig).length === 3, 5000, 'unreact frame');
      expect(reactionFrames(rig)[2]).toMatchObject({ nick: 'BOB', remove: true });
      expect(rowByMsgid(rig, '#r1', msgid).reactions).toEqual([
        { nick: 'carol', value: '👍', self: false },
      ]);
    } finally {
      rig.conn.dispose();
    }
  });

  it('reads text reactions through tag escaping', async () => {
    const rig = await connect('recv2', '#r2');
    try {
      const msgid = await peerSays(rig, 'bob', '#r2', 'shipping it tonight');
      // `\s` is an escaped space, `\:` an escaped semicolon.
      ircd.tagmsg('bob', '#r2', [`+draft/reply=${msgid}`, '+draft/react=good\\sone\\:)']);
      await until(() => reactionFrames(rig).length === 1, 5000, 'reaction');
      expect(rowByMsgid(rig, '#r2', msgid).reactions).toEqual([
        { nick: 'bob', value: 'good one;)', self: false },
      ]);
    } finally {
      rig.conn.dispose();
    }
  });

  it('records a repeated react once, and an unreact of nothing not at all', async () => {
    const rig = await connect('recv3', '#r3');
    try {
      const msgid = await peerSays(rig, 'bob', '#r3', 'hello');
      ircd.tagmsg('bob', '#r3', [`+draft/reply=${msgid}`, '+draft/react=🎉']);
      ircd.tagmsg('bob', '#r3', [`+draft/reply=${msgid}`, '+draft/react=🎉']);
      ircd.tagmsg('dave', '#r3', [`+draft/reply=${msgid}`, '+draft/unreact=🎉']);
      await barrier(rig, 'erin', '#r3', msgid);

      const frames = reactionFrames(rig).filter((e) => e.value === '🎉');
      expect(frames).toHaveLength(1);
      expect(rowByMsgid(rig, '#r3', msgid).reactions?.filter((r) => r.value === '🎉')).toEqual([
        { nick: 'bob', value: '🎉', self: false },
      ]);
    } finally {
      rig.conn.dispose();
    }
  });

  it('drops reactions that are malformed, over-long, or aimed at a line in another buffer', async () => {
    const rig = await connect('recv4', '#r4');
    try {
      rig.conn.client.join('#r4b');
      await until(
        () => rig.events.some((e) => e.type === 'channel-joined' && e.target === '#r4b'),
        5000,
        'joined #r4b',
      );
      const here = await peerSays(rig, 'bob', '#r4', 'in r4');
      const elsewhere = await peerSays(rig, 'bob', '#r4b', 'in r4b');

      // Both tags on one message: the spec forbids it, and there's no telling
      // which was meant — so a standing `a` must survive it.
      ircd.tagmsg('bob', '#r4', [`+draft/reply=${here}`, '+draft/react=a']);
      await until(() => reactionFrames(rig).length === 1, 5000, 'standing a');
      ircd.tagmsg('bob', '#r4', [`+draft/reply=${here}`, '+draft/react=a', '+draft/unreact=a']);
      // No reply tag: nothing to hang it on.
      ircd.tagmsg('bob', '#r4', ['+draft/react=b']);
      // 65 graphemes — one over the cap.
      ircd.tagmsg('bob', '#r4', [`+draft/reply=${here}`, `+draft/react=${'x'.repeat(65)}`]);
      // Blank.
      ircd.tagmsg('bob', '#r4', [`+draft/reply=${here}`, '+draft/react=\\s']);
      // Sent to #r4, replying to a line that lives in #r4b.
      ircd.tagmsg('bob', '#r4', [`+draft/reply=${elsewhere}`, '+draft/react=c']);
      // A msgid nobody has.
      ircd.tagmsg('bob', '#r4', ['+draft/reply=nope', '+draft/react=d']);
      await barrier(rig, 'erin', '#r4', here);

      // Only the standing `a` and the barrier landed.
      expect(reactionFrames(rig).map((e) => e.value)).toEqual(['a', `probe${barrierSeq}`]);
      expect(rowByMsgid(rig, '#r4', here).reactions?.map((r) => r.value)).toEqual([
        'a',
        `probe${barrierSeq}`,
      ]);
      expect(rowByMsgid(rig, '#r4b', elsewhere).reactions).toBeUndefined();
      // 64 graphemes is fine — and a flag counts as one, not two code points.
      ircd.tagmsg('bob', '#r4', [`+draft/reply=${here}`, `+draft/react=${'🇩🇪'.repeat(64)}`]);
      await until(() => reactionFrames(rig).length === 3, 5000, '64-grapheme reaction');
    } finally {
      rig.conn.dispose();
    }
  });

  it('drops a reaction from someone the user ignores', async () => {
    const rig = await connect('recv6', '#r6');
    try {
      const added = ignoreRulesService.add(userId, rig.network.id, maskToRuleInput('mallory!*@*')!);
      expect(added.ok).toBe(true);
      const msgid = await peerSays(rig, 'bob', '#r6', 'hello');
      ircd.tagmsg('mallory', '#r6', [`+draft/reply=${msgid}`, '+draft/react=💩']);
      await barrier(rig, 'erin', '#r6', msgid);
      expect(reactionFrames(rig).some((e) => e.nick === 'mallory')).toBe(false);
      expect(rowByMsgid(rig, '#r6', msgid).reactions?.map((r) => r.nick)).toEqual(['erin']);
    } finally {
      rig.conn.dispose();
    }
  });

  // An ignore added AFTER someone reacted blocks their new reactions, never
  // their unreact — or the old one could never come off.
  it('still takes an unreact from someone ignored after they reacted', async () => {
    const rig = await connect('recv7', '#r7');
    try {
      const msgid = await peerSays(rig, 'bob', '#r7', 'hello');
      ircd.tagmsg('trent', '#r7', [`+draft/reply=${msgid}`, '+draft/react=👍']);
      await until(() => reactionFrames(rig).length === 1, 5000, 'trent reacted');
      const added = ignoreRulesService.add(userId, rig.network.id, maskToRuleInput('trent!*@*')!);
      expect(added.ok).toBe(true);
      ircd.tagmsg('trent', '#r7', [`+draft/reply=${msgid}`, '+draft/unreact=👍']);
      await until(() => reactionFrames(rig).length === 2, 5000, 'trent unreacted');
      expect(rowByMsgid(rig, '#r7', msgid).reactions).toBeUndefined();
      // …while a NEW reaction from them is still refused.
      ircd.tagmsg('trent', '#r7', [`+draft/reply=${msgid}`, '+draft/react=🎉']);
      await barrier(rig, 'erin', '#r7', msgid);
      expect(rowByMsgid(rig, '#r7', msgid).reactions?.map((r) => r.nick)).toEqual(['erin']);
    } finally {
      rig.conn.dispose();
    }
  });

  // A server-pushed replay (Ergo autoreplay, ZNC playback) repeats a window of
  // history on reconnect. None of its TAGMSGs count, as none of its lines do: a
  // window that ends between an unreact and the re-react after it would take
  // back a reaction that stands, and Ergo's history keeps reacts but not
  // unreacts, so a reaction taken back would come back. Typing is stale.
  it.each(['chathistory', 'draft/chathistory', 'znc.in/playback'])(
    'ignores reactions and typing replayed inside a %s batch',
    async (batchType) => {
      const nick = `recv8${batchType.replace(/\W/g, '')}`.slice(0, 16);
      const chan = `#r8${batchType.replace(/\W/g, '')}`;
      const rig = await connect(nick, chan);
      try {
        const msgid = await peerSays(rig, 'bob', chan, 'the build is green');
        // Standing now: carol's 👍 and our own 👀, both given live.
        ircd.tagmsg('carol', chan, [`+draft/reply=${msgid}`, '+draft/react=👍']);
        expect(rig.conn.sendReaction(chan, msgid, '👀', false)).toBe(true);
        await until(() => reactionFrames(rig).length === 2, 5000, 'live reactions');

        // The window: times long past, as a replay's are.
        const at = (s: number) => `time=2020-01-01T00:00:0${s}.000Z`;
        const reply = `+draft/reply=${msgid}`;
        const line = (from: string, id: string, tags: string) =>
          `@batch=h1;msgid=${id};${tags} :${from}!~${from}@peer.fake TAGMSG ${chan}`;
        ircd.sendRaw(nick, `BATCH +h1 ${batchType} ${chan}`);
        // Unreacts of reactions given again since.
        ircd.sendRaw(nick, line('carol', 'old1', `${at(1)};${reply};+draft/unreact=👍`));
        ircd.sendRaw(nick, line(nick, 'old2', `${at(2)};${reply};+draft/unreact=👀`));
        // A react with no unreact after it (Ergo never stores one).
        ircd.sendRaw(nick, line('carol', 'old3', `${at(3)};${reply};+draft/react=🎉`));
        // Given and taken back inside the window.
        ircd.sendRaw(nick, line('dave', 'old4', `${at(4)};${reply};+draft/react=🔥`));
        ircd.sendRaw(nick, line('dave', 'old5', `${at(5)};${reply};+draft/unreact=🔥`));
        ircd.sendRaw(nick, line('carol', 'old6', `${at(6)};+typing=active`));
        ircd.sendRaw(nick, 'BATCH -h1');
        await barrier(rig, 'erin', chan, msgid);

        expect(reactionFrames(rig).map((e) => [e.nick, e.value, e.remove])).toEqual([
          ['carol', '👍', false],
          [nick, '👀', false],
          ['erin', `probe${barrierSeq}`, false],
        ]);
        expect(rig.events.some((e) => e.type === 'typing')).toBe(false);
        expect(rowByMsgid(rig, chan, msgid).reactions).toEqual([
          { nick: 'carol', value: '👍', self: false },
          { nick, value: '👀', self: true },
          { nick: 'erin', value: `probe${barrierSeq}`, self: false },
        ]);
      } finally {
        rig.conn.dispose();
      }
    },
  );

  it('routes a DM reaction to the sender’s buffer', async () => {
    const rig = await connect('recv5');
    try {
      const msgid = await peerSays(rig, 'frank', 'recv5', 'psst');
      ircd.tagmsg('frank', 'recv5', [`+draft/reply=${msgid}`, '+draft/react=👀']);
      await until(() => reactionFrames(rig).length === 1, 5000, 'dm reaction');
      expect(reactionFrames(rig)[0]).toMatchObject({ target: 'frank', value: '👀' });
      expect(rowByMsgid(rig, 'frank', msgid).reactions).toEqual([
        { nick: 'frank', value: '👀', self: false },
      ]);
    } finally {
      rig.conn.dispose();
    }
  });
});

describe('reactions to our own lines', () => {
  it('lands in the reactions feed, and leaves it on unreact', async () => {
    const rig = await connect('mine1', '#m1');
    try {
      rig.conn.client.say('#m1', 'my line');
      // echo-message: the echo is the stored self row, and brings the msgid.
      await until(
        () => rows(rig, '#m1').some((m) => m.self && m.text === 'my line' && m.msgid),
        5000,
        'own line stored with msgid',
      );
      const mine = rows(rig, '#m1').find((m) => m.text === 'my line')!;

      ircd.tagmsg('bob', '#m1', [`+draft/reply=${mine.msgid}`, '+draft/react=❤️']);
      await until(() => reactionFrames(rig).length === 1, 5000, 'reaction');
      expect(reactionFrames(rig)[0]).toMatchObject({ toSelf: true, self: false });

      const feed = listReactionsToUser(userId, { networkId: rig.network.id });
      expect(feed).toHaveLength(1);
      expect(feed[0]).toMatchObject({
        id: mine.id,
        networkId: rig.network.id,
        target: '#m1',
        nick: 'bob',
        // Kept so a host-mask ignore added later still applies in the feed.
        userhost: 'bob!~bob@peer.fake',
        value: '❤️',
        text: 'my line',
      });
      // Filters: from: is who reacted, in: is where the line is.
      expect(
        listReactionsToUser(userId, { nicks: ['BOB'], networkId: rig.network.id }),
      ).toHaveLength(1);
      expect(
        listReactionsToUser(userId, { nicks: ['carol'], networkId: rig.network.id }),
      ).toHaveLength(0);
      expect(
        listReactionsToUser(userId, { target: '#M1', networkId: rig.network.id }),
      ).toHaveLength(1);
      expect(
        listReactionsToUser(userId, { query: 'MY LINE', networkId: rig.network.id }),
      ).toHaveLength(1);
      expect(
        listReactionsToUser(userId, { query: 'nothing', networkId: rig.network.id }),
      ).toHaveLength(0);

      ircd.tagmsg('bob', '#m1', [`+draft/reply=${mine.msgid}`, '+draft/unreact=❤️']);
      await until(() => reactionFrames(rig).length === 2, 5000, 'unreact');
      expect(listReactionsToUser(userId, { networkId: rig.network.id })).toHaveLength(0);
    } finally {
      rig.conn.dispose();
    }
  });
});

describe('sending reactions', () => {
  it('sends both reply tags, and records ours only from the echo', async () => {
    const rig = await connect('send1', '#s1');
    try {
      expect(rig.events.find((e) => e.type === 'react-support')).toMatchObject({ canReact: true });
      const msgid = await peerSays(rig, 'bob', '#s1', 'react to me');
      const row = rowByMsgid(rig, '#s1', msgid);
      expect(reactionSendTarget(userId, row.id)).toEqual({
        networkId: rig.network.id,
        target: '#s1',
        msgid,
      });

      expect(rig.conn.sendReaction('#s1', msgid, '🎉', false)).toBe(true);
      await until(() => reactionFrames(rig).length === 1, 5000, 'our echo');

      const sent = ircd.client('send1')!.sent.find((l) => l.includes('TAGMSG #s1'))!;
      expect(sent).toContain(`+reply=${msgid}`);
      expect(sent).toContain(`+draft/reply=${msgid}`);
      expect(sent).toContain('+draft/react=🎉');
      expect(reactionFrames(rig)[0]).toMatchObject({ nick: 'send1', self: true, value: '🎉' });
      expect(rowByMsgid(rig, '#s1', msgid).reactions).toEqual([
        { nick: 'send1', value: '🎉', self: true },
      ]);
      // Our reactions are never in our own feed.
      expect(listReactionsToUser(userId, { networkId: rig.network.id })).toHaveLength(0);

      rig.conn.sendReaction('#s1', msgid, '🎉', true);
      await until(() => reactionFrames(rig).length === 2, 5000, 'our unreact echo');
      expect(rowByMsgid(rig, '#s1', msgid).reactions).toBeUndefined();
    } finally {
      rig.conn.dispose();
    }
  });

  it('takes back a reaction given under an older nick', async () => {
    const rig = await connect('nickA', '#s3');
    try {
      const msgid = await peerSays(rig, 'bob', '#s3', 'react then rename');
      rig.conn.sendReaction('#s3', msgid, '👍', false);
      await until(() => reactionFrames(rig).length === 1, 5000, 'reacted as nickA');

      rig.conn.client.changeNick('nickB');
      await until(
        () => rig.events.some((e) => e.type === 'own-nick' && e.nick === 'nickB'),
        5000,
        'renamed',
      );
      // The unreact echo comes from nickB; the stored reaction is nickA's.
      rig.conn.sendReaction('#s3', msgid, '👍', true);
      await until(() => reactionFrames(rig).length === 2, 5000, 'unreact as nickB');
      expect(reactionFrames(rig)[1]).toMatchObject({ nick: 'nickB', self: true, remove: true });
      expect(rowByMsgid(rig, '#s3', msgid).reactions).toBeUndefined();
    } finally {
      rig.conn.dispose();
    }
  });

  it('refuses a value it would drop if it came in', async () => {
    const rig = await connect('send2', '#s2');
    try {
      const msgid = await peerSays(rig, 'bob', '#s2', 'hi');
      expect(rig.conn.sendReaction('#s2', msgid, '', false)).toBe(false);
      expect(rig.conn.sendReaction('#s2', msgid, 'x'.repeat(65), false)).toBe(false);
      expect(rig.conn.sendReaction('#s2', msgid, 'two\nlines', false)).toBe(false);
    } finally {
      rig.conn.dispose();
    }
  });

  it('follows cap-notify: off when echo-message is withdrawn, back on when it returns', async () => {
    const rig = await connect('capdel', '#cd');
    try {
      const support = () => rig.events.filter((e) => e.type === 'react-support');
      expect(support().at(-1)).toMatchObject({ canReact: true });
      ircd.sendRaw('capdel', ':irc.fake CAP capdel DEL :echo-message');
      await until(() => support().length === 2, 5000, 'react-support after DEL');
      // A reply needs no echo (our line is stored when we send it): it stays.
      expect(support().at(-1)).toMatchObject({
        canReact: false,
        canAddReaction: false,
        canRemoveReaction: false,
        canReply: true,
      });
      expect(rig.conn.canSendReactions()).toBe(false);
      ircd.sendRaw('capdel', ':irc.fake CAP capdel ACK :echo-message');
      await until(() => support().length === 3, 5000, 'react-support after ACK');
      expect(support().at(-1)).toMatchObject({ canReact: true });
    } finally {
      rig.conn.dispose();
    }
  });

  // No message-tags, no TAGMSG — supportsTag() answers false for every tag.
  it('is off when message-tags is withdrawn, even with echo-message still on', async () => {
    const rig = await connect('capdel2', '#cd2');
    try {
      const support = () => rig.events.filter((e) => e.type === 'react-support');
      expect(support().at(-1)).toMatchObject({ canReact: true });
      ircd.sendRaw('capdel2', ':irc.fake CAP capdel2 DEL :message-tags');
      await until(() => support().length === 2, 5000, 'react-support after DEL');
      expect(support().at(-1)).toMatchObject({ canReact: false });
      expect(rig.conn.echoActive()).toBe(true);
    } finally {
      rig.conn.dispose();
    }
  });

  it('is off on a network whose CLIENTTAGDENY forbids the tags', async () => {
    const rig = await connect('deny1', '#d1', denyIrcd.port);
    try {
      expect(rig.events.find((e) => e.type === 'react-support')).toEqual(
        expect.objectContaining({
          canReact: false,
          canAddReaction: false,
          canRemoveReaction: false,
          canReply: false,
        }),
      );
      expect(rig.conn.canSendReactions()).toBe(false);
      expect(rig.conn.sendReaction('#d1', 'm1', '👍', false)).toBe(false);
      expect(denyIrcd.client('deny1')!.sent.some((l) => l.includes('TAGMSG'))).toBe(false);
    } finally {
      rig.conn.dispose();
    }
  });

  // #1101: a network that allows +draft/react but not +draft/unreact still
  // takes a reaction, and a reply; only taking a reaction back is refused.
  it('reacts and replies where only draft/unreact is denied, and refuses the unreact', async () => {
    const rig = await connect('unreal1', '#u1', unrealIrcd.port);
    try {
      // canReact keeps its old meaning (both directions), so a client that
      // predates the split offers nothing here rather than a dead take-back.
      const support = {
        canReact: false,
        canAddReaction: true,
        canRemoveReaction: false,
        canReply: true,
      };
      expect(rig.events.find((e) => e.type === 'react-support')).toEqual(
        expect.objectContaining(support),
      );
      expect(rig.conn.snapshot()).toMatchObject(support);
      expect(rig.conn.sendReaction('#u1', 'm1', '👍', true)).toBe(false);
      expect(rig.conn.sendReaction('#u1', 'm1', '👍', false)).toBe(true);
      await until(
        () => unrealIrcd.client('unreal1')!.sent.some((l) => l.includes('TAGMSG #u1')),
        5000,
        'reaction sent',
      );
      const tagmsgs = unrealIrcd.client('unreal1')!.sent.filter((l) => l.includes('TAGMSG #u1'));
      expect(tagmsgs).toHaveLength(1);
      expect(tagmsgs[0]).toContain('+draft/react=👍');
      expect(tagmsgs[0]).not.toContain('unreact');
    } finally {
      rig.conn.dispose();
    }
  });

  // One reply name allowed is enough to react, but the forbidden one stays off
  // the wire — the same per-name filter a reply's tags go through.
  it('leaves off the reply tag name CLIENTTAGDENY forbids', async () => {
    const rig = await connect('deny2', '#d2', draftDenyIrcd.port);
    try {
      expect(rig.conn.canSendReactions()).toBe(true);
      expect(rig.conn.sendReaction('#d2', 'm1', '👍', false)).toBe(true);
      await until(
        () => draftDenyIrcd.client('deny2')!.sent.some((l) => l.includes('TAGMSG #d2')),
        5000,
        'reaction sent',
      );
      const sent = draftDenyIrcd.client('deny2')!.sent.find((l) => l.includes('TAGMSG #d2'))!;
      expect(sent).toContain('+reply=m1');
      expect(sent).not.toContain('+draft/reply');
      expect(sent).toContain('+draft/react=👍');
    } finally {
      rig.conn.dispose();
    }
  });
});

describe('ircManager.react', () => {
  function stubConn() {
    const sendReaction = vi.fn<IrcConnection['sendReaction']>(() => true);
    const publishEphemeral = vi.fn<IrcConnection['publishEphemeral']>();
    const conn = {
      state: 'connected',
      sendReaction,
      publishEphemeral,
      statusTarget: () => null,
    } as unknown as IrcConnection;
    return { conn, sendReaction, publishEphemeral };
  }

  function storedLine(network: Network, target: string): number {
    return Number(
      insertMessage({
        networkId: network.id,
        target,
        time: new Date().toISOString(),
        type: 'message',
        nick: 'bob',
        text: 'a plaintext line',
        msgid: `mgr${++seq}`,
      }).id,
    );
  }

  afterEach(() => vi.restoreAllMocks());

  it('sends to the line’s buffer with its msgid', () => {
    const network = makeNetwork('mgr1');
    const id = storedLine(network, '#plain');
    const { conn, sendReaction } = stubConn();
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(conn);
    expect(ircManager.react(userId, id, '👍', false)).toBe(true);
    expect(sendReaction).toHaveBeenCalledWith('#plain', `mgr${seq}`, '👍', false);
  });

  // A network in reconnect backoff keeps its connection object, but a TAGMSG
  // written to it is dropped: the reaction must be refused, not reported sent.
  it('refuses while the network is not connected', () => {
    const network = makeNetwork('mgr3');
    const id = storedLine(network, '#plain');
    const { conn, sendReaction } = stubConn();
    (conn as unknown as { state: string }).state = 'reconnecting';
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(conn);
    expect(ircManager.react(userId, id, '👍', false)).toBe(false);
    expect(sendReaction).not.toHaveBeenCalled();
  });

  // A reaction is a cleartext tag, so even a plaintext line on an E2E channel
  // can't take one — it would put the reaction on the wire in the clear.
  it('refuses on an E2E channel, and says so', () => {
    const network = makeNetwork('mgr2');
    const id = storedLine(network, '#secret');
    const { conn, sendReaction, publishEphemeral } = stubConn();
    vi.spyOn(ircManager, 'getConnection').mockReturnValue(conn);
    vi.spyOn(e2eManager, 'isChannelEnabled').mockReturnValue(true);
    expect(ircManager.react(userId, id, '👍', false)).toBe(false);
    expect(sendReaction).not.toHaveBeenCalled();
    expect(publishEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'e2e', level: 'warn', target: '#secret' }),
    );
  });
});
