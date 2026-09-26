// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 replies (client-tags/reply, #993) end to end: a real IrcConnection over
// a real socket to the fake ircd, so the tags go through irc-framework's parser
// exactly as they would from a network. What's asserted is what the user would
// see — the reply context a line carries when read back and on its live frame,
// whether it highlights — plus what goes out on the wire when we reply.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import db from '../db/index.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { countHighlightsNewer, listMessages, searchMessages } from '../db/messages.js';
import type { MessageEvent } from '../db/messages.js';
import { IrcConnection } from './ircConnection.js';
import ignoreRulesService from './ignoreRulesService.js';
import ircManager from './ircManager.js';
import { maskToRuleInput } from './ignoreRuleInput.js';
import { FakeIrcd, DEFAULT_CAPS } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

type Ev = Record<string, unknown>;

let ircd: FakeIrcd;
let denyIrcd: FakeIrcd;
let noEchoIrcd: FakeIrcd;
let userId: number;
let seq = 0;

beforeAll(async () => {
  ircd = await FakeIrcd.start();
  // A network that forbids every client-only tag.
  denyIrcd = await FakeIrcd.start({ isupport: ['CLIENTTAGDENY=*'] });
  // Tags but no echo-message: our own lines are published at send time.
  noEchoIrcd = await FakeIrcd.start({ caps: DEFAULT_CAPS.filter((c) => c !== 'echo-message') });
  userId = createUser('replies-int').id;
});

afterAll(async () => {
  await ircd.close();
  await denyIrcd.close();
  await noEchoIrcd.close();
});

afterEach(() => vi.restoreAllMocks());

interface Rig {
  conn: IrcConnection;
  events: Ev[];
  network: Network;
  ircd: FakeIrcd;
}

// Connected, through the end of the registration burst (react-support is
// published once the MOTD closes it, after CLIENTTAGDENY), and in `chans`.
async function connect(nick: string, chans: string[], server = ircd): Promise<Rig> {
  const network = createNetwork(userId, {
    name: `reply-${seq++}`,
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    nick,
    autoconnect: false,
  })!;
  const events: Ev[] = [];
  const conn = new IrcConnection({ network, onEvent: (e) => events.push(e as Ev) });
  conn.connect();
  await until(() => events.some((e) => e.type === 'react-support'), 5000, 'end of burst');
  for (const chan of chans) {
    conn.client.join(chan);
    await until(
      () => events.some((e) => e.type === 'channel-joined' && e.target === chan),
      5000,
      `joined ${chan}`,
    );
  }
  return { conn, events, network, ircd: server };
}

function rows(rig: Rig, target: string): MessageEvent[] {
  return listMessages(rig.network.id, target, { limit: 200 });
}

function rowByText(rig: Rig, target: string, text: string): MessageEvent {
  const row = rows(rig, target).find((m) => m.text === text);
  if (!row) throw new Error(`no stored row "${text}" in ${target}`);
  return row;
}

function liveByText(rig: Rig, text: string): Ev {
  const ev = rig.events.find((e) => e.text === text && typeof e.id === 'number');
  if (!ev) throw new Error(`no live frame "${text}"`);
  return ev;
}

// A peer's line, stored — returns its msgid.
async function peerSays(
  rig: Rig,
  from: string,
  target: string,
  text: string,
  clientTags: string[] = [],
): Promise<string> {
  const msgid = rig.ircd.say(from, target, text, clientTags);
  const where = target.startsWith('#') ? target : from;
  await until(() => rows(rig, where).some((m) => m.msgid === msgid), 5000, `stored "${text}"`);
  return msgid;
}

// One of our own lines, stored from its echo — returns its row.
async function weSay(rig: Rig, target: string, text: string): Promise<MessageEvent> {
  rig.conn.say(target, text);
  await until(() => rows(rig, target).some((m) => m.text === text), 5000, `echo "${text}"`);
  return rowByText(rig, target, text);
}

describe('receiving replies', () => {
  it('reads a reply’s parent back, on the stored row and the live frame', async () => {
    const rig = await connect('recv1', ['#r1']);
    try {
      const parentMsgid = await peerSays(rig, 'alice', '#r1', 'anyone tried the new build?');
      const parent = rows(rig, '#r1').find((m) => m.msgid === parentMsgid)!;

      await peerSays(rig, 'bob', '#r1', 'alice: works for me', [`+draft/reply=${parentMsgid}`]);
      const expected = {
        msgid: parentMsgid,
        parent: {
          id: parent.id,
          nick: 'alice',
          type: 'message',
          text: 'anyone tried the new build?',
          userhost: 'alice!~alice@peer.fake',
          self: false,
        },
      };
      expect(rowByText(rig, '#r1', 'alice: works for me').replyTo).toEqual(expected);
      expect(liveByText(rig, 'alice: works for me').replyTo).toEqual(expected);
      // The tag's value is resolved, never shipped bare.
      expect(liveByText(rig, 'alice: works for me')).not.toHaveProperty('replyMsgid');

      // The ratified `+reply` reads the same.
      await peerSays(rig, 'carol', '#r1', 'same here', [`+reply=${parentMsgid}`]);
      expect(rowByText(rig, '#r1', 'same here').replyTo).toEqual(expected);

      // A line that isn't a reply carries nothing.
      expect(rowByText(rig, '#r1', 'anyone tried the new build?')).not.toHaveProperty('replyTo');
    } finally {
      rig.conn.dispose();
    }
  });

  it('keeps a reply whose parent it can’t find, with no context', async () => {
    const rig = await connect('recv2', ['#r2', '#r2b']);
    try {
      await peerSays(rig, 'bob', '#r2', 'to nothing', ['+draft/reply=never-seen']);
      expect(rowByText(rig, '#r2', 'to nothing').replyTo).toEqual({
        msgid: 'never-seen',
        parent: null,
      });
      expect(liveByText(rig, 'to nothing').replyTo).toEqual({ msgid: 'never-seen', parent: null });

      // A msgid from another buffer is not this buffer's line to quote.
      const elsewhere = await peerSays(rig, 'alice', '#r2b', 'said in #r2b');
      await peerSays(rig, 'bob', '#r2', 'cross-buffer', [`+draft/reply=${elsewhere}`]);
      expect(rowByText(rig, '#r2', 'cross-buffer').replyTo).toEqual({
        msgid: elsewhere,
        parent: null,
      });
    } finally {
      rig.conn.dispose();
    }
  });

  it('loses the parent when retention takes it, and keeps the reply', async () => {
    const rig = await connect('recv3', ['#r3']);
    try {
      const parentMsgid = await peerSays(rig, 'alice', '#r3', 'soon gone');
      await peerSays(rig, 'bob', '#r3', 'answering it', [`+draft/reply=${parentMsgid}`]);
      expect(rowByText(rig, '#r3', 'answering it').replyTo?.parent?.text).toBe('soon gone');

      db.prepare('DELETE FROM messages WHERE id = ?').run(rowByText(rig, '#r3', 'soon gone').id);
      expect(rowByText(rig, '#r3', 'answering it').replyTo).toEqual({
        msgid: parentMsgid,
        parent: null,
      });
    } finally {
      rig.conn.dispose();
    }
  });

  it('doesn’t quote a parent from someone ignored when it arrived', async () => {
    const rig = await connect('recv4', ['#r4']);
    try {
      const added = ignoreRulesService.add(userId, rig.network.id, maskToRuleInput('troll!*@*')!);
      expect(added.ok).toBe(true);
      const parentMsgid = await peerSays(rig, 'troll', '#r4', 'something awful');
      await peerSays(rig, 'bob', '#r4', 'ugh', [`+draft/reply=${parentMsgid}`]);
      expect(rowByText(rig, '#r4', 'ugh').replyTo).toEqual({ msgid: parentMsgid, parent: null });
    } finally {
      rig.conn.dispose();
    }
  });
});

// The stored thread root (#993, for a threaded view): read straight off the row,
// since nothing puts it on the wire yet.
function rootOf(rig: Rig, target: string, text: string): string | null {
  const id = rowByText(rig, target, text).id;
  return (
    db.prepare('SELECT reply_root_msgid AS root FROM messages WHERE id = ?').get(id) as {
      root: string | null;
    }
  ).root;
}

describe('thread roots', () => {
  it('points every reply down a chain at the line that started it', async () => {
    const rig = await connect('root1', ['#t1']);
    try {
      const top = await peerSays(rig, 'alice', '#t1', 'top of thread');
      const r1 = await peerSays(rig, 'bob', '#t1', 'first reply', [`+draft/reply=${top}`]);
      await peerSays(rig, 'carol', '#t1', 'reply to the reply', [`+draft/reply=${r1}`]);
      expect(rootOf(rig, '#t1', 'top of thread')).toBeNull();
      expect(rootOf(rig, '#t1', 'first reply')).toBe(top);
      expect(rootOf(rig, '#t1', 'reply to the reply')).toBe(top);
    } finally {
      rig.conn.dispose();
    }
  });

  it('roots at the parent it can’t find, and keeps that root down the chain', async () => {
    const rig = await connect('root2', ['#t2']);
    try {
      const r1 = await peerSays(rig, 'bob', '#t2', 'to an unknown line', ['+draft/reply=lost1']);
      await peerSays(rig, 'carol', '#t2', 'and onward', [`+draft/reply=${r1}`]);
      expect(rootOf(rig, '#t2', 'to an unknown line')).toBe('lost1');
      expect(rootOf(rig, '#t2', 'and onward')).toBe('lost1');
    } finally {
      rig.conn.dispose();
    }
  });

  // The quote skips someone ignored; the thread must not come apart over them.
  it('threads through a line from someone ignored', async () => {
    const rig = await connect('root3', ['#t3']);
    try {
      const added = ignoreRulesService.add(userId, rig.network.id, maskToRuleInput('troll!*@*')!);
      expect(added.ok).toBe(true);
      const top = await peerSays(rig, 'alice', '#t3', 'start');
      const mid = await peerSays(rig, 'troll', '#t3', 'bait', [`+draft/reply=${top}`]);
      await peerSays(rig, 'bob', '#t3', 'answering the troll', [`+draft/reply=${mid}`]);
      expect(rootOf(rig, '#t3', 'answering the troll')).toBe(top);
    } finally {
      rig.conn.dispose();
    }
  });

  it('roots our own reply the same way', async () => {
    const rig = await connect('root4', ['#t4']);
    try {
      vi.spyOn(ircManager, 'getConnection').mockReturnValue(rig.conn);
      const top = await peerSays(rig, 'alice', '#t4', 'question');
      const r1 = await peerSays(rig, 'bob', '#t4', 'partial answer', [`+draft/reply=${top}`]);
      const parent = rowByText(rig, '#t4', 'partial answer');
      expect(parent.msgid).toBe(r1);
      ircManager.send(userId, rig.network.id, '#t4', 'bob: more to it', { replyTo: parent.id });
      await until(() => rows(rig, '#t4').some((m) => m.text === 'bob: more to it'), 5000, 'echo');
      expect(rootOf(rig, '#t4', 'bob: more to it')).toBe(top);
    } finally {
      rig.conn.dispose();
    }
  });
});

describe('a reply to the user', () => {
  it('is a highlight — live, on the row, in the count and the feed', async () => {
    const rig = await connect('mine1', ['#h1']);
    try {
      const mine = await weSay(rig, '#h1', 'my question');
      const theirs = await peerSays(rig, 'alice', '#h1', 'someone else’s line');
      const before = mine.id;

      // No nick in the text, so no rule matches: the reply alone makes it one.
      await peerSays(rig, 'bob', '#h1', 'good question', [`+draft/reply=${mine.msgid}`]);
      await peerSays(rig, 'bob', '#h1', 'not to you', [`+draft/reply=${theirs}`]);

      expect(liveByText(rig, 'good question')).toMatchObject({ matched: true, replyToSelf: true });
      expect(rowByText(rig, '#h1', 'good question')).toMatchObject({
        matched: true,
        replyToSelf: true,
      });
      expect(liveByText(rig, 'not to you').matched).toBe(false);
      expect(liveByText(rig, 'not to you')).not.toHaveProperty('replyToSelf');
      expect(rowByText(rig, '#h1', 'not to you').matched).toBe(false);
      expect(rowByText(rig, '#h1', 'not to you')).not.toHaveProperty('replyToSelf');
      expect(countHighlightsNewer(rig.network.id, '#h1', before)).toBe(1);
      const feed = searchMessages(userId, { matched: true, networkId: rig.network.id });
      expect(feed.map((m) => m.text)).toEqual(['good question']);
    } finally {
      rig.conn.dispose();
    }
  });

  it('counts once when a rule matches it too', async () => {
    const rig = await connect('mine2', ['#h2']);
    try {
      const mine = await weSay(rig, '#h2', 'ping me back');
      // Addressed AND a reply: the own-nick rule matches as well.
      await peerSays(rig, 'bob', '#h2', 'mine2: sure', [`+draft/reply=${mine.msgid}`]);
      expect(countHighlightsNewer(rig.network.id, '#h2', mine.id)).toBe(1);
    } finally {
      rig.conn.dispose();
    }
  });

  it('isn’t one when it’s our own reply to our own line', async () => {
    const rig = await connect('mine3', ['#h3']);
    try {
      const mine = await weSay(rig, '#h3', 'first thought');
      rig.conn.say('#h3', 'second thought', { '+draft/reply': mine.msgid! });
      await until(() => rows(rig, '#h3').some((m) => m.text === 'second thought'), 5000, 'echo');
      const row = rowByText(rig, '#h3', 'second thought');
      expect(row.replyTo?.parent?.id).toBe(mine.id);
      expect(row.matched).toBe(false);
    } finally {
      rig.conn.dispose();
    }
  });

  it('is silenced by a NOHIGHLIGHT ignore on the replier', async () => {
    const rig = await connect('mine4', ['#h4']);
    try {
      const added = ignoreRulesService.add(userId, rig.network.id, {
        ...maskToRuleInput('pest!*@*')!,
        levels: ['NOHIGHLIGHT'],
      });
      expect(added.ok).toBe(true);
      const mine = await weSay(rig, '#h4', 'hello all');
      await peerSays(rig, 'pest', '#h4', 'hi hi hi', [`+draft/reply=${mine.msgid}`]);
      expect(rowByText(rig, '#h4', 'hi hi hi').matched).toBe(false);
      expect(rowByText(rig, '#h4', 'hi hi hi')).not.toHaveProperty('replyToSelf');
      expect(countHighlightsNewer(rig.network.id, '#h4', mine.id)).toBe(0);
    } finally {
      rig.conn.dispose();
    }
  });
});

describe('sending replies', () => {
  it('tags the first line with both names, and reads our echo back as a reply', async () => {
    const rig = await connect('send1', ['#s1']);
    try {
      vi.spyOn(ircManager, 'getConnection').mockReturnValue(rig.conn);
      const parentMsgid = await peerSays(rig, 'alice', '#s1', 'what time is it?');
      const parent = rowByText(rig, '#s1', 'what time is it?');

      expect(
        ircManager.send(userId, rig.network.id, '#s1', 'alice: noon', { replyTo: parent.id }),
      ).toBe(true);
      await until(() => rows(rig, '#s1').some((m) => m.text === 'alice: noon'), 5000, 'echo');

      const sent = ircd.client('send1')!.sent.find((l) => l.includes('PRIVMSG #s1 :alice: noon'))!;
      expect(sent).toContain(`+reply=${parentMsgid}`);
      expect(sent).toContain(`+draft/reply=${parentMsgid}`);
      expect(rowByText(rig, '#s1', 'alice: noon').replyTo?.parent?.id).toBe(parent.id);
    } finally {
      rig.conn.dispose();
    }
  });

  it('tags a /me reply', async () => {
    const rig = await connect('send2', ['#s2']);
    try {
      vi.spyOn(ircManager, 'getConnection').mockReturnValue(rig.conn);
      const parentMsgid = await peerSays(rig, 'alice', '#s2', 'who broke the build');
      const parent = rowByText(rig, '#s2', 'who broke the build');

      ircManager.action(userId, rig.network.id, '#s2', 'hides', { replyTo: parent.id });
      await until(
        () => rows(rig, '#s2').some((m) => m.type === 'action' && m.text === 'hides'),
        5000,
        'action echo',
      );
      const sent = ircd.client('send2')!.sent.find((l) => l.includes('\x01ACTION hides\x01'))!;
      expect(sent).toMatch(/^@.*\+reply=/);
      expect(sent).toContain(`+draft/reply=${parentMsgid}`);
      const row = rows(rig, '#s2').find((m) => m.type === 'action' && m.text === 'hides')!;
      expect(row.replyTo?.parent?.id).toBe(parent.id);
    } finally {
      rig.conn.dispose();
    }
  });

  it('sends a plain line when the parent is in another buffer', async () => {
    const rig = await connect('send3', ['#s3', '#s3b']);
    try {
      vi.spyOn(ircManager, 'getConnection').mockReturnValue(rig.conn);
      await peerSays(rig, 'alice', '#s3b', 'over here');
      const elsewhere = rowByText(rig, '#s3b', 'over here');

      ircManager.send(userId, rig.network.id, '#s3', 'wrong room', { replyTo: elsewhere.id });
      await until(() => rows(rig, '#s3').some((m) => m.text === 'wrong room'), 5000, 'echo');
      const sent = ircd.client('send3')!.sent.find((l) => l.includes('PRIVMSG #s3 :wrong room'))!;
      expect(sent).not.toContain('reply=');
      expect(rowByText(rig, '#s3', 'wrong room')).not.toHaveProperty('replyTo');
    } finally {
      rig.conn.dispose();
    }
  });

  it('sends a plain line where CLIENTTAGDENY forbids the tags', async () => {
    const rig = await connect('send4', ['#s4'], denyIrcd);
    try {
      vi.spyOn(ircManager, 'getConnection').mockReturnValue(rig.conn);
      await peerSays(rig, 'alice', '#s4', 'deny me');
      const parent = rowByText(rig, '#s4', 'deny me');

      ircManager.send(userId, rig.network.id, '#s4', 'alice: denied', { replyTo: parent.id });
      await until(() => rows(rig, '#s4').some((m) => m.text === 'alice: denied'), 5000, 'echo');
      const sent = denyIrcd
        .client('send4')!
        .sent.find((l) => l.includes('PRIVMSG #s4 :alice: denied'))!;
      expect(sent).not.toContain('reply=');
      expect(rowByText(rig, '#s4', 'alice: denied')).not.toHaveProperty('replyTo');
    } finally {
      rig.conn.dispose();
    }
  });

  it('marks our own copy as a reply without echo-message, first line only', async () => {
    const rig = await connect('send5', ['#s5'], noEchoIrcd);
    try {
      vi.spyOn(ircManager, 'getConnection').mockReturnValue(rig.conn);
      await peerSays(rig, 'alice', '#s5', 'long answer please');
      const parent = rowByText(rig, '#s5', 'long answer please');

      const long = 'x'.repeat(800);
      ircManager.send(userId, rig.network.id, '#s5', long, { replyTo: parent.id });
      const mine = rows(rig, '#s5').filter((m) => m.self);
      expect(mine.length).toBeGreaterThan(1);
      expect(mine[0].replyTo?.parent?.id).toBe(parent.id);
      for (const later of mine.slice(1)) expect(later).not.toHaveProperty('replyTo');

      const privmsgs = () =>
        noEchoIrcd.client('send5')!.sent.filter((l) => l.includes('PRIVMSG #s5'));
      await until(() => privmsgs().length === mine.length, 5000, 'every chunk on the wire');
      expect(privmsgs()[0]).toContain('+reply=');
      for (const later of privmsgs().slice(1)) expect(later).not.toContain('reply=');
    } finally {
      rig.conn.dispose();
    }
  });
});
