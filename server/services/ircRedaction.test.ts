// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 message redaction (draft/message-redaction, #1013) end to end: a real
// IrcConnection over a real socket to the fake ircd, as ircReactions.test.ts
// does. What's asserted is what the user would see — the line read back as a
// placeholder, its quote in a reply, its reactions gone, the live frame, search
// — plus what went out on the wire.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { listMessages, searchMessages, redactSendTarget } from '../db/messages.js';
import type { MessageEvent } from '../db/messages.js';
import { IrcConnection } from './ircConnection.js';
import ircManager from './ircManager.js';
import { DEFAULT_CAPS, FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Ev = Record<string, unknown>;

const REDACTION_CAP = 'draft/message-redaction';

let ircd: FakeIrcd;
let opIrcd: FakeIrcd;
let plainIrcd: FakeIrcd;
let userId: number;
let seq = 0;

beforeAll(async () => {
  ircd = await FakeIrcd.start({ caps: [...DEFAULT_CAPS, REDACTION_CAP] });
  // Where the user may delete anyone's line, as a channel op may on ergo.
  opIrcd = await FakeIrcd.start({ caps: [...DEFAULT_CAPS, REDACTION_CAP], redactAny: true });
  // A network without the cap.
  plainIrcd = await FakeIrcd.start();
  userId = createUser('redaction-int').id;
});

afterAll(async () => {
  await ircd.close();
  await opIrcd.close();
  await plainIrcd.close();
});

function makeNetwork(nick: string, port: number): Network {
  return createNetwork(userId, {
    name: `redact-${seq++}`,
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
  ircd: FakeIrcd;
}

async function connect(nick: string, chan?: string, on: FakeIrcd = ircd): Promise<Rig> {
  const network = makeNetwork(nick, on.port);
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
  // ircManager.redact looks the connection up by network.
  ircManager.connectionsForUser(userId).set(network.id, conn);
  return { conn, events, network, nick, ircd: on };
}

function dispose(rig: Rig): void {
  ircManager.connectionsForUser(userId).delete(rig.network.id);
  rig.conn.dispose();
}

function rows(rig: Rig, target: string): MessageEvent[] {
  return listMessages(rig.network.id, target, { limit: 200 });
}

function rowByMsgid(rig: Rig, target: string, msgid: string): MessageEvent {
  const row = rows(rig, target).find((m) => m.msgid === msgid);
  if (!row) throw new Error(`no stored row with msgid ${msgid} in ${target}`);
  return row;
}

async function peerSays(rig: Rig, from: string, target: string, text: string): Promise<string> {
  const msgid = rig.ircd.say(from, target, text);
  const where = target.startsWith('#') ? target : from;
  await until(() => rows(rig, where).some((m) => m.msgid === msgid), 5000, `stored "${text}"`);
  return msgid;
}

// Our own line, stored by its echo — returns its msgid.
async function iSay(rig: Rig, target: string, text: string): Promise<string> {
  rig.conn.client.say(target, text);
  await until(
    () => rows(rig, target).some((m) => m.self && m.text === text),
    5000,
    `echo "${text}"`,
  );
  return rows(rig, target).find((m) => m.self && m.text === text)!.msgid!;
}

const redactedFrames = (rig: Rig) => rig.events.filter((e) => e.type === 'message-redacted');
const sentBy = (rig: Rig) => rig.ircd.client(rig.nick)?.sent ?? [];

describe('a REDACT from the network', () => {
  it('blanks the line, says who deleted it, and tells clients', async () => {
    const rig = await connect('recv1', '#d1');
    try {
      const msgid = await peerSays(rig, 'bob', '#d1', 'oops wrong channel');
      ircd.redact('bob', '#d1', msgid);
      await until(() => redactedFrames(rig).length === 1, 5000, 'message-redacted frame');

      const row = rowByMsgid(rig, '#d1', msgid);
      expect(row.text).toBeNull();
      expect(row.redaction).toMatchObject({ by: 'bob' });
      expect(row.redaction?.reason).toBeUndefined();
      expect(typeof row.redaction?.time).toBe('string');
      expect(redactedFrames(rig)[0]).toMatchObject({
        target: '#d1',
        bufferId: row.bufferId,
        messageId: row.id,
        by: 'bob',
        self: false,
      });
    } finally {
      dispose(rig);
    }
  });

  it('keeps the reason, and names an op who deleted someone else’s line', async () => {
    const rig = await connect('recv2', '#d2');
    try {
      const msgid = await peerSays(rig, 'bob', '#d2', 'spam spam spam');
      ircd.redact('opal', '#d2', msgid, 'no spam here');
      await until(() => redactedFrames(rig).length === 1, 5000, 'frame');
      const row = rowByMsgid(rig, '#d2', msgid);
      expect(row.nick).toBe('bob');
      expect(row.redaction).toMatchObject({ by: 'opal', reason: 'no spam here' });
      expect(redactedFrames(rig)[0]).toMatchObject({ by: 'opal', reason: 'no spam here' });
    } finally {
      dispose(rig);
    }
  });

  it('takes the reactions down with the line, and its quote in replies reads as deleted', async () => {
    const rig = await connect('recv3', '#d3');
    try {
      const msgid = await peerSays(rig, 'bob', '#d3', 'who wants pizza');
      ircd.tagmsg('carol', '#d3', [`+draft/reply=${msgid}`, '+draft/react=🍕']);
      await until(() => rowByMsgid(rig, '#d3', msgid).reactions?.length === 1, 5000, 'reaction');
      const replyId = ircd.say('carol', '#d3', 'bob: me', [`+draft/reply=${msgid}`]);
      await until(() => rows(rig, '#d3').some((m) => m.msgid === replyId), 5000, 'reply stored');
      expect(rowByMsgid(rig, '#d3', replyId).replyTo?.parent?.text).toBe('who wants pizza');

      ircd.redact('bob', '#d3', msgid);
      await until(() => redactedFrames(rig).length === 1, 5000, 'frame');

      expect(rowByMsgid(rig, '#d3', msgid).reactions).toBeUndefined();
      const quote = rowByMsgid(rig, '#d3', replyId).replyTo?.parent;
      expect(quote).toMatchObject({ nick: 'bob', text: '', redacted: true });
    } finally {
      dispose(rig);
    }
  });

  it('drops the line from search', async () => {
    const rig = await connect('recv4', '#d4');
    try {
      const msgid = await peerSays(rig, 'bob', '#d4', 'the xylophone incident');
      const hits = () => searchMessages(userId, { query: 'xylophone', networkId: rig.network.id });
      expect(hits().some((m) => m.msgid === msgid)).toBe(true);
      ircd.redact('bob', '#d4', msgid);
      await until(() => redactedFrames(rig).length === 1, 5000, 'frame');
      expect(hits().some((m) => m.msgid === msgid)).toBe(false);
    } finally {
      dispose(rig);
    }
  });

  it('lands a DM REDACT addressed to us in the sender’s buffer', async () => {
    const rig = await connect('recv5');
    try {
      const msgid = await peerSays(rig, 'bob', rig.nick, 'secret');
      ircd.redact('bob', rig.nick, msgid);
      await until(() => redactedFrames(rig).length === 1, 5000, 'frame');
      expect(redactedFrames(rig)[0]).toMatchObject({ target: 'bob', by: 'bob' });
      expect(rowByMsgid(rig, 'bob', msgid).text).toBeNull();
    } finally {
      dispose(rig);
    }
  });

  it('ignores a msgid it does not hold, and a second REDACT for the same line', async () => {
    const rig = await connect('recv6', '#d6');
    try {
      const msgid = await peerSays(rig, 'bob', '#d6', 'first');
      ircd.redact('bob', '#d6', 'never-minted');
      // A reaction's own msgid names no line.
      const reactionMsgid = ircd.tagmsg('carol', '#d6', [
        `+draft/reply=${msgid}`,
        '+draft/react=👍',
      ]);
      ircd.redact('carol', '#d6', reactionMsgid);
      ircd.redact('bob', '#d6', msgid);
      await until(() => redactedFrames(rig).length === 1, 5000, 'frame');
      ircd.redact('bob', '#d6', msgid);
      // A later line proves the repeat was handled, and produced nothing.
      await peerSays(rig, 'bob', '#d6', 'barrier');
      expect(redactedFrames(rig)).toHaveLength(1);
      expect(rowByMsgid(rig, '#d6', msgid).reactions).toBeUndefined();
    } finally {
      dispose(rig);
    }
  });
});

describe('deleting a line of ours', () => {
  it('sends REDACT with the reason, and applies the network’s echo', async () => {
    const rig = await connect('send1', '#s1');
    try {
      const msgid = await iSay(rig, '#s1', 'typo');
      const row = rowByMsgid(rig, '#s1', msgid);
      expect(redactSendTarget(userId, row.id)).toMatchObject({ target: '#s1', msgid, self: true });
      expect(ircManager.redact(userId, row.id, 'meant the other channel')).toBe(true);
      await until(() => redactedFrames(rig).length === 1, 5000, 'our own REDACT echoed');
      expect(sentBy(rig)).toContain(`REDACT #s1 ${msgid} :meant the other channel`);
      expect(rowByMsgid(rig, '#s1', msgid)).toMatchObject({
        text: null,
        redaction: { by: rig.nick, reason: 'meant the other channel' },
      });
      expect(redactedFrames(rig)[0]).toMatchObject({ self: true, by: rig.nick });
      // Deleted once: nothing left to send for.
      expect(redactSendTarget(userId, row.id)).toBeNull();
      expect(ircManager.redact(userId, row.id)).toBe(false);
    } finally {
      dispose(rig);
    }
  });

  it('puts the network’s refusal in the buffer, and never blanks the line', async () => {
    const rig = await connect('send2', '#s2');
    try {
      const msgid = await peerSays(rig, 'bob', '#s2', 'not yours');
      const row = rowByMsgid(rig, '#s2', msgid);
      expect(ircManager.redact(userId, row.id)).toBe(true);
      await until(
        () => rig.events.some((e) => e.type === 'error' && e.target === '#s2'),
        5000,
        'FAIL in the channel',
      );
      const err = rig.events.find((e) => e.type === 'error' && e.target === '#s2')!;
      expect(String(err.text)).toMatch(/Couldn't delete the message: .*REDACT_FORBIDDEN/);
      expect(sentBy(rig)).toContain(`REDACT #s2 ${msgid}`);
      expect(rowByMsgid(rig, '#s2', msgid).text).toBe('not yours');
      expect(redactedFrames(rig)).toHaveLength(0);
    } finally {
      dispose(rig);
    }
  });

  it('deletes someone else’s line where the network allows it', async () => {
    const rig = await connect('send3', '#s3', opIrcd);
    try {
      const msgid = await peerSays(rig, 'bob', '#s3', 'off topic');
      const row = rowByMsgid(rig, '#s3', msgid);
      expect(ircManager.redact(userId, row.id, 'off topic')).toBe(true);
      await until(() => redactedFrames(rig).length === 1, 5000, 'frame');
      expect(rowByMsgid(rig, '#s3', msgid).redaction).toMatchObject({
        by: rig.nick,
        reason: 'off topic',
      });
    } finally {
      dispose(rig);
    }
  });

  it('offers nothing on a network without the cap', async () => {
    const rig = await connect('send4', '#s4', plainIrcd);
    try {
      const support = rig.events.filter((e) => e.type === 'react-support').at(-1)!;
      expect(support.canRedact).toBe(false);
      const msgid = await iSay(rig, '#s4', 'stays');
      const row = rowByMsgid(rig, '#s4', msgid);
      expect(ircManager.redact(userId, row.id)).toBe(false);
      expect(sentBy(rig).some((l) => l.startsWith('REDACT'))).toBe(false);
    } finally {
      dispose(rig);
    }
  });

  it('advertises canRedact once the cap is negotiated', async () => {
    const rig = await connect('send5');
    try {
      const support = rig.events.filter((e) => e.type === 'react-support').at(-1)!;
      expect(support.canRedact).toBe(true);
    } finally {
      dispose(rig);
    }
  });
});
