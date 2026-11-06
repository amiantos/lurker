// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Who each reply is for (replyRouter.ts): every line of a reply to whoever
// asked, a turn for the queries whose replies name nothing to match by, and an
// end for a client whose query can't finish. The ircd behaviour these lines copy
// is in the plan's "Reply routing" section: solanum, InspIRCd, UnrealIRCd, Ergo.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ircLineParser } from 'irc-framework';
import { ReplyRouter } from './replyRouter.js';
import type { ReplyClient, ReplyOwner } from './replyRouter.js';

class Client implements ReplyClient {
  cached: string[][] = [];
  aborted: string[] = [];
  replyFromCache(lines: string[]): void {
    this.cached.push(lines);
  }
  replyAborted(numeric: string, params: string[]): void {
    this.aborted.push([numeric, ...params].join(' '));
  }
}

function setup(
  opts: { joined?: string[]; listModes?: string; timeoutMs?: number; settleMs?: number } = {},
) {
  const writes: string[] = [];
  const state = { connected: true };
  const joined = new Set((opts.joined ?? []).map((c) => c.toLowerCase()));
  // A connection with nothing queued: the line goes at once (#1149).
  const router = new ReplyRouter({
    write: (line, onSent) => {
      writes.push(typeof line === 'function' ? line() : line);
      onSent?.(performance.now());
      return { cancel: () => false };
    },
    canSend: () => state.connected,
    fold: (name) => name.toLowerCase(),
    isJoined: (channel) => joined.has(channel.toLowerCase()),
    ownNick: () => 'me',
    listModes: () => new Set((opts.listModes ?? 'beIq').split('')),
    prefixModes: () => new Set(['o', 'v']),
    timeoutMs: opts.timeoutMs ?? 30_000,
    settleMs: opts.settleMs ?? 1_000,
  });
  // A line from the server, as IrcConnection's raw listener hands it over.
  const hear = (line: string): ReplyOwner => {
    const msg = ircLineParser(line)!;
    return router.noteServerLine(line, msg.command, msg.params, msg.prefix?.split('!')[0]);
  };
  return { router, writes, hear, state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CHATHISTORY (the history gap-fill, #1283)', () => {
  it('the batch answering it, nested batches included, is Lurker’s; the next request waits for nothing', () => {
    const { router, writes, hear } = setup();
    const ended: string[] = [];
    router.send('lurker', 'CHATHISTORY BETWEEN #a timestamp=x timestamp=y 100', undefined, {
      onEnd: (how) => ended.push(how),
    });
    expect(writes).toEqual(['CHATHISTORY BETWEEN #a timestamp=x timestamp=y 100']);
    // Another target's batch is not this one's.
    expect(hear(':srv BATCH +z chathistory #b')).toBe('unasked');
    expect(hear(':srv BATCH +r chathistory #A')).toBe('lurker');
    expect(hear('@batch=r :p!u@h PRIVMSG #a :one')).toBe('lurker');
    expect(hear('@batch=r :srv BATCH +m draft/multiline #a')).toBe('lurker');
    expect(hear('@batch=m :p!u@h PRIVMSG #a :part')).toBe('lurker');
    expect(hear('@batch=r :srv BATCH -m')).toBe('lurker');
    // A bare line while the batch is open is someone else's.
    expect(hear(':q!u@h PRIVMSG #a :live')).toBe('unasked');
    expect(hear(':srv BATCH -r')).toBe('lurker');
    expect(ended).toEqual(['replied']);
  });

  it('a FAIL naming another request’s channel does not end this one', () => {
    const { router, hear } = setup();
    const ended: string[] = [];
    router.send('lurker', 'CHATHISTORY BETWEEN #a timestamp=x timestamp=y 100', undefined, {
      onEnd: (how) => ended.push(`a:${how}`),
    });
    router.send('user', 'CHATHISTORY LATEST #b * 50', undefined, {
      onEnd: (how) => ended.push(`b:${how}`),
    });
    expect(hear(':srv FAIL CHATHISTORY INVALID_TARGET LATEST #b :no')).toBe('user');
    expect(ended).toEqual(['b:error']);
    expect(hear(':srv FAIL CHATHISTORY MESSAGE_ERROR BETWEEN #a :no')).toBe('lurker');
    expect(ended).toEqual(['b:error', 'a:error']);
  });

  it('a request that cannot go out is ended at once, so the next can', () => {
    const { router, state } = setup();
    state.connected = false;
    const ended: string[] = [];
    router.send('lurker', 'CHATHISTORY BETWEEN #a timestamp=x timestamp=y 100', undefined, {
      onEnd: (how) => ended.push(how),
    });
    expect(ended).toEqual(['error']);
  });

  it('a batch whose request timed out before it closed stays Lurker’s to the end', () => {
    fakeTimers();
    const { router, hear } = setup({ timeoutMs: 1000 });
    router.send('lurker', 'CHATHISTORY BETWEEN #a timestamp=x timestamp=y 100');
    expect(hear(':srv BATCH +r chathistory #a')).toBe('lurker');
    vi.advanceTimersByTime(1500);
    vi.runOnlyPendingTimers();
    // The lines that trickle in late are still the page's, never a client's.
    expect(hear('@batch=r :p!u@h PRIVMSG #a :late')).toBe('lurker');
    expect(hear(':srv BATCH -r')).toBe('lurker');
    expect(hear('@batch=r :p!u@h PRIVMSG #a :after')).toBe('unasked');
  });
});

function fakeTimers(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date'],
  });
}

describe('a client that detaches', () => {
  it('takes its query out of the queue before it has gone, and frees what waited on it', () => {
    // The connection holds the line: nothing goes until told.
    const held: Array<() => void> = [];
    const writes: string[] = [];
    const router = new ReplyRouter({
      write: (line, onSent) => {
        const text = typeof line === 'function' ? line() : line;
        const h = () => {
          writes.push(text);
          onSent?.(performance.now());
        };
        held.push(h);
        return { cancel: () => held.splice(held.indexOf(h), 1).length > 0 };
      },
      canSend: () => true,
      fold: (name) => name.toLowerCase(),
      isJoined: () => true,
      ownNick: () => 'me',
      listModes: () => new Set('beIq'.split('')),
      prefixModes: () => new Set(['o', 'v']),
    });
    const gone = new Client();
    const stays = new Client();
    router.send(gone, 'WHO #c');
    router.send(stays, 'WHO #d');
    expect(held).toHaveLength(1); // the second WHO waits for the first
    router.dropClient(gone);
    expect(held).toHaveLength(1);
    held[0]();
    expect(writes).toEqual(['WHO #d']);
  });
});

describe('a socket that dies with a query still queued', () => {
  it('tells the query it was dropped, as any line dropped with its socket', () => {
    // A user's /whois behind a paste: reset() takes it out of the queue, and
    // the sender hears "not sent" through onDropped, as a PRIVMSG's does.
    const router = new ReplyRouter({
      write: () => ({ cancel: () => true }),
      canSend: () => true,
      fold: (name) => name.toLowerCase(),
      isJoined: () => true,
      ownNick: () => 'me',
      listModes: () => new Set('beIq'.split('')),
      prefixModes: () => new Set(['o', 'v']),
    });
    const dropped: string[] = [];
    router.send('user', 'WHOIS bob', undefined, { onDropped: () => dropped.push('WHOIS bob') });
    router.reset();
    expect(dropped).toEqual(['WHOIS bob']);
  });
});

describe("Lurker's own query still in the queue", () => {
  it("steps aside for a client's query of its kind, and waits behind it instead", () => {
    // The away-sync WHO waits in the low lane behind a paste; a bouncer
    // client's WHO for the same channel must not wait that out.
    const held = new Map<string, () => void>();
    const writes: string[] = [];
    const router = new ReplyRouter({
      write: (line, onSent) => {
        const text = typeof line === 'function' ? line() : line;
        writes.push(text);
        held.set(text, () => onSent?.(performance.now()));
        return { cancel: () => held.delete(text) };
      },
      canSend: () => true,
      fold: (name) => name.toLowerCase(),
      isJoined: () => true,
      ownNick: () => 'me',
      listModes: () => new Set('beIq'.split('')),
      prefixModes: () => new Set(['o', 'v']),
    });
    const client = new Client();
    router.send('lurker', 'WHO #c');
    expect(writes).toEqual(['WHO #c']);
    router.send(client, 'WHO #c');
    // Lurker's was taken back out of the queue; the client's is in it.
    expect(writes).toEqual(['WHO #c', 'WHO #c']);
    expect(held.size).toBe(1);
    held.get('WHO #c')!();
    const line = ':irc.test 315 me #c :End of /WHO list.';
    const msg = ircLineParser(line)!;
    expect(router.noteServerLine(line, msg.command, msg.params, 'irc.test')).toBe(client);
    // And now Lurker's goes.
    expect(writes).toEqual(['WHO #c', 'WHO #c', 'WHO #c']);
  });
});

describe('what waits its turn', () => {
  it('holds a second WHO until the first ends', () => {
    const { router, writes, hear } = setup();
    const a = new Client();
    const b = new Client();
    router.send(a, 'WHO #c');
    router.send(b, 'WHO #d');
    expect(writes).toEqual(['WHO #c']);
    expect(hear(':irc.test 352 me #c ~u h irc.test bob H :0 Bob')).toBe(a);
    expect(writes).toEqual(['WHO #c']);
    expect(hear(':irc.test 315 me #c :End of /WHO list.')).toBe(a);
    expect(writes).toEqual(['WHO #c', 'WHO #d']);
    expect(hear(':irc.test 315 me #d :End of /WHO list.')).toBe(b);
  });

  it.each(['LIST', 'ISON bob', 'USERHOST bob', 'MODE me', 'ACCEPT *'])(
    'holds a second %s too: its replies name nothing',
    (query) => {
      const { router, writes } = setup();
      router.send(new Client(), query);
      router.send(new Client(), query);
      expect(writes).toEqual([query]);
    },
  );

  it('sends queries whose replies name what they answer at once', () => {
    const { router, writes } = setup();
    const queries = [
      'WHOIS bob',
      'WHOIS bob',
      'WHOWAS bob',
      'NAMES #c',
      'NAMES #c',
      'TOPIC #c',
      'TOPIC #c',
      'MODE #c b',
      'MODE #c b',
    ];
    for (const query of queries) router.send(new Client(), query);
    expect(writes).toEqual(queries);
  });

  it('holds a client’s MODE #chan behind one already asking about that channel', () => {
    const { router, writes } = setup();
    router.send('lurker', 'MODE #c');
    router.send(new Client(), 'MODE #c');
    router.send(new Client(), 'MODE #d');
    router.send('user', 'MODE #c');
    expect(writes).toEqual(['MODE #c', 'MODE #d', 'MODE #c']);
  });

  it('doesn’t let a query nobody answers hold up the next of its kind', () => {
    const { router, writes, hear } = setup();
    const a = new Client();
    const b = new Client();
    // A restore asks for our user modes, and a server that never answers that
    // mustn't hold back every channel's MODE after it.
    router.send('lurker', 'MODE me');
    router.send(a, 'MODE #c');
    router.send('lurker', 'TOPIC #held');
    router.send(b, 'TOPIC #c');
    expect(writes).toEqual(['MODE me', 'MODE #c', 'TOPIC #held', 'TOPIC #c']);
    expect(hear(':irc.test 324 me #c +nt')).toBe(a);
    expect(hear(':irc.test 331 me #c :No topic is set.')).toBe(b);
  });

  it('writes a line that asks nothing at once', () => {
    const { router, writes } = setup();
    const a = new Client();
    const lines = [
      'LIST',
      'LIST',
      'MODE #c +o bob',
      'MODE #c +b *!*@bad',
      'MODE bob',
      'TOPIC #c :a new topic',
      'PRIVMSG #c :hi',
    ];
    for (const line of lines) router.send(a, line);
    expect(writes).toEqual(lines.slice(1));
  });

  it('queues a command however it is spelled', () => {
    const { router, writes } = setup();
    router.send(new Client(), 'who #c');
    router.send(new Client(), 'WHO #d');
    expect(writes).toEqual(['who #c']);
  });

  it('counts q as a list query only where q is a list mode', () => {
    const quiets = setup();
    const a = new Client();
    quiets.router.send(a, 'MODE #c q');
    expect(quiets.hear(':irc.test 729 me #c q :End of Quiet List')).toBe(a);
    // InspIRCd's q is the owner prefix, so this sets nothing up.
    const owners = setup({ listModes: 'beI' });
    owners.router.send(a, 'MODE #c q');
    expect(owners.hear(':irc.test 729 me #c q :End of Quiet List')).toBe('nobody');
  });

  it('builds the line when it goes out, not when it is queued', () => {
    const { router, writes, hear } = setup();
    let built = 0;
    router.send(new Client(), 'WHO #c');
    router.send('lurker', 'WHO #d', () => {
      built += 1;
      return 'WHO #d %tcuhsnfdaor,5';
    });
    expect(built).toBe(0);
    hear(':irc.test 315 me #c :End of /WHO list.');
    expect(built).toBe(1);
    expect(writes).toEqual(['WHO #c', 'WHO #d %tcuhsnfdaor,5']);
  });
});

describe('who a reply is for', () => {
  const cases: Array<[string, string, string[]]> = [
    [
      'WHOX',
      'WHO #c %tcuhsnfdaor,7',
      [
        ':irc.test 354 me 7 #c ~u h irc.test bob H 0 bob 0 :Bob',
        ':irc.test 315 me #c :End of /WHO list.',
      ],
    ],
    [
      'WHOIS',
      'WHOIS bob',
      [
        ':irc.test 311 me bob ~u h * :Bob',
        ':irc.test 319 me bob :@#c',
        ':irc.test 330 me bob bob :is logged in as',
        ':irc.test 318 me bob :End of /WHOIS list.',
      ],
    ],
    [
      'WHOWAS',
      'WHOWAS bob',
      [':irc.test 314 me bob ~u h * :Bob', ':irc.test 369 me bob :End of WHOWAS'],
    ],
    [
      'LIST',
      'LIST',
      [
        ':irc.test 321 me Channel :Users  Name',
        ':irc.test 322 me #c 3 :a topic',
        ':irc.test 323 me :End of /LIST',
      ],
    ],
    [
      'NAMES',
      'NAMES #c',
      [':irc.test 353 me = #c :me @bob', ':irc.test 366 me #c :End of /NAMES list.'],
    ],
    [
      'ban list',
      'MODE #c b',
      [':irc.test 367 me #c *!*@bad op 1700000000', ':irc.test 368 me #c :End of Channel Ban List'],
    ],
    [
      'exception list',
      'MODE #c +e',
      [':irc.test 348 me #c *!*@good', ':irc.test 349 me #c :End of Channel Exception List'],
    ],
    [
      'quiet list',
      'MODE #c q',
      [':irc.test 728 me #c q *!*@loud op 1700000000', ':irc.test 729 me #c q :End of Quiet List'],
    ],
    ['our user modes', 'MODE me', [':irc.test 221 me +i']],
    ['no topic', 'TOPIC #c', [':irc.test 331 me #c :No topic is set.']],
    ['ISON', 'ISON bob carol', [':irc.test 303 me :bob']],
    ['USERHOST', 'USERHOST bob', [':irc.test 302 me :bob=+~u@h']],
    [
      'the accept list',
      'ACCEPT *',
      [':irc.test 281 me alice bob', ':irc.test 282 me :End of /ACCEPT list.'],
    ],
    // draft/metadata-2 (#607): a SET's reply is one bare 761 naming the
    // target (`*` means us); a LIST is a `metadata` batch; a SUB ends on its 770.
    [
      'METADATA SET',
      'METADATA * SET avatar :https://x/a.png',
      [':irc.test 761 me me avatar * :https://x/a.png'],
    ],
    [
      'METADATA LIST',
      'METADATA bob LIST',
      [
        ':irc.test BATCH +m1 metadata bob',
        '@batch=m1 :irc.test 761 me bob display-name * :Bob',
        '@batch=m1 :irc.test 766 me bob avatar :key not set',
        ':irc.test BATCH -m1',
      ],
    ],
    [
      'METADATA SUB',
      'METADATA * SUB avatar display-name',
      [':irc.test 770 me avatar display-name'],
    ],
    ['METADATA SYNC postponed', 'METADATA #c SYNC', [':irc.test 774 me #c 5']],
  ];

  it.each(cases)(
    '%s: the first reply to the first asker, the second to the second',
    (_, query, lines) => {
      const { router, writes, hear } = setup();
      const a = new Client();
      const b = new Client();
      router.send(a, query);
      router.send(b, query);
      for (const line of lines) expect(hear(line)).toBe(a);
      for (const line of lines) expect(hear(line)).toBe(b);
      expect(writes).toEqual([query, query]);
    },
  );

  it('gives the 329 after a 324 to the same asker', () => {
    const { router, writes, hear } = setup();
    const a = new Client();
    router.send(a, 'MODE #c');
    router.send(new Client(), 'MODE #c');
    expect(hear(':irc.test 324 me #c +nt')).toBe(a);
    expect(writes).toHaveLength(1);
    expect(hear(':irc.test 329 me #c 1700000000')).toBe(a);
    expect(writes).toHaveLength(2);
  });

  it('gives the 333 after a 332 to the same asker', () => {
    const { router, hear } = setup();
    const a = new Client();
    router.send(a, 'TOPIC #c');
    expect(hear(':irc.test 332 me #c :a topic')).toBe(a);
    expect(hear(':irc.test 333 me #c op 1700000000')).toBe(a);
  });

  it('lets the next line end the wait for a 329 that never comes', () => {
    const { router, writes, hear } = setup();
    const a = new Client();
    const b = new Client();
    router.send(a, 'MODE #c');
    router.send(b, 'MODE #c');
    expect(hear(':irc.test 324 me #c +nt')).toBe(a);
    expect(hear(':bob!~u@h PRIVMSG #c :hi')).toBe('unasked');
    expect(writes).toHaveLength(2);
    expect(hear(':irc.test 324 me #c +nt')).toBe(b);
  });

  it('ends the wait on a quiet connection after a moment', () => {
    fakeTimers();
    const { router, writes, hear } = setup({ settleMs: 1_000 });
    router.send(new Client(), 'MODE #c');
    router.send(new Client(), 'MODE #c');
    hear(':irc.test 324 me #c +nt');
    vi.advanceTimersByTime(999);
    expect(writes).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(writes).toHaveLength(2);
  });

  it('counts Lurker and the user as askers', () => {
    const { router, hear } = setup();
    router.send('lurker', 'WHO #c');
    router.send('user', 'WHOIS bob');
    expect(hear(':irc.test 315 me #c :End of /WHO list.')).toBe('lurker');
    expect(hear(':irc.test 318 me bob :End of /WHOIS list.')).toBe('user');
  });

  it('ends WHOIS a,b on one 318 naming both, or on the last nick’s own', () => {
    const one = setup();
    const a = new Client();
    one.router.send(a, 'WHOIS a,b');
    expect(one.hear(':irc.test 311 me a ~u h * :A')).toBe(a);
    expect(one.hear(':irc.test 318 me a,b :End of /WHOIS list.')).toBe(a);
    expect(one.hear(':irc.test 318 me a,b :End of /WHOIS list.')).toBe('nobody');

    // InspIRCd answers each nick in full.
    const each = setup();
    each.router.send(a, 'WHOIS a,b');
    expect(each.hear(':irc.test 318 me a :End of /WHOIS list.')).toBe(a);
    expect(each.hear(':irc.test 311 me b ~u h * :B')).toBe(a);
    expect(each.hear(':irc.test 318 me b :End of /WHOIS list.')).toBe(a);
    expect(each.hear(':irc.test 318 me b :End of /WHOIS list.')).toBe('nobody');
  });

  it('matches a reply that names its target to the query that names it', () => {
    const { router, hear } = setup();
    const a = new Client();
    const b = new Client();
    // A two-argument WHOIS for someone on another server is answered late.
    router.send(a, 'WHOIS bob bob');
    router.send(b, 'WHOIS carol');
    expect(hear(':irc.test 311 me carol ~u h * :Carol')).toBe(b);
    expect(hear(':irc.test 318 me carol :End of /WHOIS list.')).toBe(b);
    expect(hear(':irc.test 311 me bob ~u h * :Bob')).toBe(a);
    expect(hear(':irc.test 318 me bob :End of /WHOIS list.')).toBe(a);
  });

  it('leaves a WHOIS line about someone else alone', () => {
    const { router, hear } = setup();
    const a = new Client();
    router.send(a, 'WHOIS bob');
    expect(hear(':irc.test 311 me bob ~u h * :Bob')).toBe(a);
    // A PRIVMSG to someone away draws a 301 too.
    expect(hear(':irc.test 301 me alice :gone fishing')).toBe('unasked');
    expect(hear(':irc.test 301 me bob :gone fishing')).toBe(a);
  });

  it("takes a 301 for a WHOIS only once the WHOIS's own lines have begun", () => {
    const { router, hear } = setup();
    const a = new Client();
    router.send(a, 'WHOIS bob');
    // A PRIVMSG to bob, who's away, is answered before the WHOIS is.
    expect(hear(':irc.test 301 me bob :gone fishing')).toBe('unasked');
    expect(hear(':irc.test 311 me bob ~u h * :Bob')).toBe(a);
    expect(hear(':irc.test 301 me bob :gone fishing')).toBe(a);
    expect(hear(':irc.test 318 me bob :End of /WHOIS list.')).toBe(a);
  });

  it('keeps WHOIS lines with no WHOIS on the wire from everyone', () => {
    const { hear } = setup();
    // A reply to a query that timed out, or to the previous process's.
    for (const numeric of ['310', '337', '343', '671', '406']) {
      expect(hear(`:irc.test ${numeric} me bob :about bob`)).toBe('nobody');
    }
    expect(hear(':irc.test 301 me bob :gone fishing')).toBe('unasked');
  });

  it("ends a WHOWAS on its 406, and doesn't give that to a WHOIS", () => {
    const { router, writes, hear } = setup();
    const a = new Client();
    const b = new Client();
    router.send(a, 'WHOIS bob');
    router.send(b, 'WHOWAS bob');
    expect(hear(':irc.test 406 me bob :There was no such nickname')).toBe(b);
    expect(hear(':irc.test 369 me bob :End of WHOWAS')).toBe(b);
    router.send(b, 'WHOWAS carol');
    expect(hear(':irc.test 406 me carol :There was no such nickname')).toBe(b);
    // A server that sends no 369 after it: the next line ends the wait.
    expect(hear(':bob!~u@h PRIVMSG me :hi')).toBe('unasked');
    expect(writes).toEqual(['WHOIS bob', 'WHOWAS bob', 'WHOWAS carol']);
  });

  it('ends a WHO on an error naming its mask', () => {
    const { router, writes, hear } = setup();
    const a = new Client();
    router.send(a, 'WHO #gone');
    router.send(new Client(), 'WHO #c');
    expect(hear(':irc.test 403 me #gone :No such channel')).toBe(a);
    expect(hear(':bob!~u@h PRIVMSG me :hi')).toBe('unasked');
    expect(writes).toEqual(['WHO #gone', 'WHO #c']);
  });

  it('takes any 3xx about the nick for its WHOIS, but no reply to another command', () => {
    const { router, hear } = setup();
    const a = new Client();
    const b = new Client();
    router.send(a, 'WHOIS bob');
    router.send(b, 'WHO bob');
    // UnrealIRCd's helpop, solanum's text, InspIRCd's oper name and country,
    // certfp, TLS.
    for (const numeric of ['310', '337', '343', '344', '276', '671']) {
      expect(hear(`:irc.test ${numeric} me bob :about bob`)).toBe(a);
    }
    // The end of a WHO for the same nick, and an INVITE's reply naming it.
    expect(hear(':irc.test 315 me bob :End of /WHO list.')).toBe(b);
    expect(hear(':irc.test 341 me bob #c')).toBe('unasked');
  });

  it('leaves NAMES for another channel alone', () => {
    const { router, hear } = setup();
    const a = new Client();
    router.send(a, 'NAMES #c');
    // The NAMES a JOIN brings.
    expect(hear(':irc.test 353 me = #other :me carol')).toBe('unasked');
    expect(hear(':irc.test 366 me #other :End of /NAMES list.')).toBe('unasked');
    expect(hear(':irc.test 353 me = #c :me bob')).toBe(a);
    expect(hear(':irc.test 366 me #c :End of /NAMES list.')).toBe(a);
  });

  it('takes every 353 for a NAMES with no channel', () => {
    const { router, hear } = setup();
    const a = new Client();
    router.send(a, 'NAMES');
    expect(hear(':irc.test 353 me = #c :me bob')).toBe(a);
    expect(hear(':irc.test 353 me = #d :carol')).toBe(a);
    expect(hear(':irc.test 366 me * :End of /NAMES list.')).toBe(a);
  });

  it('knows a reply nobody here asked for from a line that answers nothing', () => {
    const { hear } = setup();
    expect(hear(':irc.test 352 me #c ~u h irc.test bob H :0 Bob')).toBe('nobody');
    expect(hear(':irc.test 315 me #c :End of /WHO list.')).toBe('nobody');
    expect(hear(':irc.test 311 me bob ~u h * :Bob')).toBe('nobody');
    expect(hear(':irc.test 322 me #c 3 :a topic')).toBe('nobody');
    expect(hear(':irc.test 324 me #c +nt')).toBe('unasked');
    expect(hear(':irc.test 353 me = #c :me bob')).toBe('unasked');
    expect(hear(':irc.test 366 me #c :End of /NAMES list.')).toBe('unasked');
    expect(hear(':irc.test 401 me bob :No such nick/channel')).toBe('unasked');
    expect(hear(':bob!~u@h PRIVMSG me :hi')).toBe('unasked');
  });
});

describe('errors', () => {
  const pairs: Array<[string, string, string[]]> = [
    [
      'WHOIS, 401 then 318',
      'WHOIS bob',
      [':irc.test 401 me bob :No such nick/channel', ':irc.test 318 me bob :End of /WHOIS list.'],
    ],
    [
      'WHO, 263 then 315 *',
      'WHO #c',
      [':irc.test 263 me WHO :This command could not be completed', ':irc.test 315 me * :End'],
    ],
    [
      'LIST, 263 then 323',
      'LIST',
      [':irc.test 263 me LIST :This command could not be completed', ':irc.test 323 me :End'],
    ],
    [
      'NAMES, 263 then 366 *',
      'NAMES #c',
      [':irc.test 263 me NAMES :This command could not be completed', ':irc.test 366 me * :End'],
    ],
    [
      'LIST of a missing channel, 401 then 323',
      'LIST #gone',
      [':irc.test 401 me #gone :No such nick/channel', ':irc.test 323 me :End'],
    ],
  ];

  it.each(pairs)('%s: both lines go to the asker', (_, query, lines) => {
    const { router, writes, hear } = setup();
    const a = new Client();
    const b = new Client();
    router.send(a, query);
    router.send(b, query);
    for (const line of lines) expect(hear(line)).toBe(a);
    for (const line of lines) expect(hear(line)).toBe(b);
    expect(writes).toEqual([query, query]);
  });

  it('holds the next LIST until the line after a 263 has come', () => {
    const { router, writes, hear } = setup();
    router.send(new Client(), 'LIST');
    router.send(new Client(), 'LIST');
    hear(':irc.test 263 me LIST :This command could not be completed');
    expect(writes).toHaveLength(1);
    hear(':irc.test 323 me :End');
    expect(writes).toHaveLength(2);
  });

  const alone: Array<[string, string, string]> = [
    ['402 for a bad server', 'WHOIS irc.gone bob', ':irc.test 402 me irc.gone :No such server'],
    ['461 for WHO with no mask', 'WHO', ':irc.test 461 me WHO :Not enough parameters'],
    ['479 for a bad channel name', 'NAMES #bad', ':irc.test 479 me #bad :Illegal channel name'],
    ['431 for an empty nick', 'WHOIS', ':irc.test 431 me :No nickname given'],
    ['421 for an unknown command', 'WHOWAS bob', ':irc.test 421 me WHOWAS :Unknown command'],
  ];

  it.each(alone)('%s: ends the query when the next line is something else', (_, query, error) => {
    const { router, writes, hear } = setup();
    const a = new Client();
    const b = new Client();
    router.send(a, query);
    router.send(b, query);
    expect(hear(error)).toBe(a);
    expect(hear(':bob!~u@h PRIVMSG me :hi')).toBe('unasked');
    expect(hear(error)).toBe(b);
    expect(writes).toEqual([query, query]);
  });

  it('gives an error naming a channel to the oldest query that names it', () => {
    const { router, hear } = setup();
    const a = new Client();
    const b = new Client();
    // A restore sends a channel's TOPIC and MODE together.
    router.send(a, 'TOPIC #c');
    router.send(b, 'MODE #c');
    expect(hear(":irc.test 442 me #c :You're not on that channel")).toBe(a);
    expect(hear(":irc.test 442 me #c :You're not on that channel")).toBe(b);
  });

  it('leaves an error for another target alone', () => {
    const { router, hear } = setup();
    router.send(new Client(), 'WHOIS bob');
    expect(hear(':irc.test 401 me alice :No such nick/channel')).toBe('unasked');
  });
});

describe('queries that can’t finish', () => {
  it('ends a query that hears nothing, and sends the next', () => {
    fakeTimers();
    const { router, writes } = setup({ timeoutMs: 5_000 });
    const a = new Client();
    router.send(a, 'WHO #c');
    router.send(new Client(), 'WHO #d');
    vi.advanceTimersByTime(4_999);
    expect(a.aborted).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(a.aborted).toEqual(['315 #c']);
    expect(writes).toEqual(['WHO #c', 'WHO #d']);
  });

  it('keeps a slow LIST going while its lines keep coming', () => {
    fakeTimers();
    const { router, hear } = setup({ timeoutMs: 5_000 });
    const a = new Client();
    router.send(a, 'LIST');
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(3_000);
      expect(hear(`:irc.test 322 me #c${i} 3 :topic`)).toBe(a);
    }
    expect(a.aborted).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(a.aborted).toEqual(['323']);
  });

  it('ends every client query when the socket goes', () => {
    const { router, hear } = setup();
    const a = new Client();
    const b = new Client();
    router.send(a, 'WHOIS bob');
    router.send(b, 'WHO #c');
    router.send(a, 'WHO #d');
    router.send('lurker', 'NAMES #c');
    router.send(a, 'MODE #c');
    router.reset();
    expect(a.aborted).toEqual(['318 bob', '315 #d']);
    expect(b.aborted).toEqual(['315 #c']);
    expect(hear(':irc.test 318 me bob :End of /WHOIS list.')).toBe('nobody');
  });

  it('ends a query still waiting on the line after its error when the socket goes', () => {
    const { router, hear } = setup();
    const a = new Client();
    router.send(a, 'WHOIS bob');
    hear(':irc.test 401 me bob :No such nick/channel');
    router.reset();
    expect(a.aborted).toEqual(['318 bob']);
  });

  it('ends a client query at once when nothing can be sent', () => {
    const { router, writes, state } = setup();
    state.connected = false;
    const a = new Client();
    router.send(a, 'NAMES #c');
    router.send(a, 'PRIVMSG #c :hi');
    expect(a.aborted).toEqual(['366 #c']);
    expect(writes).toEqual(['PRIVMSG #c :hi']);
  });

  it('forgets a client that detached', () => {
    const { router, writes, hear } = setup();
    const a = new Client();
    router.send(a, 'WHO #c');
    router.send(a, 'WHO #d');
    router.send(new Client(), 'WHO #e');
    router.dropClient(a);
    expect(hear(':irc.test 352 me #c ~u h irc.test bob H :0 Bob')).toBe('nobody');
    expect(hear(':irc.test 315 me #c :End of /WHO list.')).toBe('nobody');
    expect(writes).toEqual(['WHO #c', 'WHO #e']);
  });
});

describe('AWAY', () => {
  it('gives each 305 or 306 to the oldest AWAY on the wire, and sends every AWAY at once', () => {
    const { router, writes, hear } = setup();
    router.send('lurker', 'AWAY :lunch');
    router.send('user', 'AWAY');
    expect(writes).toEqual(['AWAY :lunch', 'AWAY']);
    expect(hear(':irc.test 306 me :You have been marked as being away')).toBe('lurker');
    expect(hear(':irc.test 305 me :You are no longer marked as being away')).toBe('user');
  });

  it('keeps a 305 or 306 with no AWAY on the wire from everyone', () => {
    const { hear } = setup();
    expect(hear(':irc.test 306 me :You have been marked as being away')).toBe('nobody');
    expect(hear(':irc.test 305 me :You are no longer marked as being away')).toBe('nobody');
  });

  it('doesn’t give a 306 to a WHOIS for our own nick', () => {
    const { router, hear } = setup();
    router.send(new Client(), 'WHOIS me');
    router.send('lurker', 'AWAY :lunch');
    expect(hear(':irc.test 306 me :You have been marked as being away')).toBe('lurker');
  });
});

describe('MODE #chan from cache', () => {
  const MODE_IS = ':irc.test 324 me #c +ntk hunter2';
  const CREATED = ':irc.test 329 me #c 1700000000';

  it('answers a client with the last 324 and 329', () => {
    const { router, writes, hear } = setup({ joined: ['#c'] });
    hear(MODE_IS);
    hear(CREATED);
    const a = new Client();
    router.send(a, 'MODE #c');
    expect(a.cached).toEqual([[MODE_IS, CREATED]]);
    expect(writes).toEqual([]);
  });

  it('answers a client waiting behind Lurker’s own MODE from that reply', () => {
    const { router, writes, hear } = setup({ joined: ['#c'] });
    const a = new Client();
    router.send('lurker', 'MODE #c');
    router.send(a, 'MODE #c');
    expect(hear(MODE_IS)).toBe('lurker');
    expect(a.cached).toEqual([]);
    expect(hear(CREATED)).toBe('lurker');
    expect(a.cached).toEqual([[MODE_IS, CREATED]]);
    expect(writes).toEqual(['MODE #c']);
  });

  it('asks the network again after a change a 324 shows', () => {
    const { router, writes, hear } = setup({ joined: ['#c'] });
    hear(MODE_IS);
    hear(':op!~u@h MODE #c -k hunter2');
    router.send(new Client(), 'MODE #c');
    expect(writes).toEqual(['MODE #c']);
  });

  it('keeps it through prefix and list mode changes', () => {
    const { router, hear } = setup({ joined: ['#c'] });
    hear(MODE_IS);
    hear(':op!~u@h MODE #c +o bob');
    hear(':op!~u@h MODE #c +b *!*@bad');
    const a = new Client();
    router.send(a, 'MODE #c');
    expect(a.cached).toEqual([[MODE_IS]]);
  });

  it('asks the network after our own JOIN, and for a channel we aren’t in', () => {
    const rejoined = setup({ joined: ['#c'] });
    rejoined.hear(MODE_IS);
    rejoined.hear(':me!~u@h JOIN #c');
    rejoined.router.send(new Client(), 'MODE #c');
    expect(rejoined.writes).toEqual(['MODE #c']);

    const elsewhere = setup();
    elsewhere.hear(MODE_IS);
    elsewhere.router.send(new Client(), 'MODE #c');
    expect(elsewhere.writes).toEqual(['MODE #c']);
  });

  it('sends the user’s MODE to the network', () => {
    const { router, writes, hear } = setup({ joined: ['#c'] });
    hear(MODE_IS);
    router.send('user', 'MODE #c');
    expect(writes).toEqual(['MODE #c']);
  });
});

describe('the wire is in the order lines went', () => {
  it('a reply goes to the oldest query that has GONE, not the oldest handed over', () => {
    // The connection's queue has lanes (sendPacer.ts): Lurker's own query waits
    // in `low`, a client's goes ahead of it. The 403 is the client's.
    const held = new Map<string, () => void>();
    const priorities: Array<string | undefined> = [];
    const router = new ReplyRouter({
      write: (line, onSent, _onDropped, priority) => {
        const text = typeof line === 'function' ? line() : line;
        priorities.push(priority);
        held.set(text, () => onSent?.(performance.now()));
        return { cancel: () => false };
      },
      canSend: () => true,
      fold: (name) => name.toLowerCase(),
      isJoined: () => true,
      ownNick: () => 'me',
      listModes: () => new Set('beIq'.split('')),
      prefixModes: () => new Set(['o', 'v']),
      timeoutMs: 30_000,
      settleMs: 1_000,
    });
    const client = new Client();
    router.send('lurker', 'MODE #c');
    router.send(client, 'TOPIC #c');
    expect(priorities).toEqual(['low', undefined]);
    held.get('TOPIC #c')!();
    held.get('MODE #c')!();
    const line = ':irc.example.test 403 me #c :No such channel';
    const msg = ircLineParser(line)!;
    expect(router.noteServerLine(line, msg.command, msg.params, 'irc.example.test')).toBe(client);
  });
});

// Several METADATA queries share the wire (#607): the user's LIST, Lurker's
// SUB, a bouncer client's SYNC. Each reply goes to the one it names.
describe('METADATA queries on the wire together', () => {
  it('gives a SUB its 770 and leaves the 774 after it unasked', () => {
    const { router, hear } = setup();
    const user = new Client();
    router.send(user, 'METADATA bob LIST');
    router.send('lurker', 'METADATA * SUB color');
    expect(hear(':irc.test 770 me :color')).toBe('lurker');
    // ergo's "sync everything later" answers nobody's query by name.
    expect(hear(':irc.test 774 * *ALL 0 :Try again later')).toBe('unasked');
    // The LIST is still waiting, and its batch is its.
    expect(hear(':irc.test BATCH +m1 metadata bob')).toBe(user);
    expect(hear('@batch=m1 :irc.test 761 me bob display-name * :Bob')).toBe(user);
    expect(hear(':irc.test BATCH -m1')).toBe(user);
  });

  it('gives a *ALL SYNC its batch, not a LIST for someone else', () => {
    const { router, hear } = setup();
    const user = new Client();
    router.send(user, 'METADATA bob LIST');
    router.send('lurker', 'METADATA *ALL SYNC');
    expect(hear(':irc.test BATCH +s1 metadata *ALL')).toBe('lurker');
    expect(hear('@batch=s1 :irc.test 761 * bob display-name * :Bob')).toBe('lurker');
    expect(hear(':irc.test BATCH -s1')).toBe('lurker');
    expect(hear(':irc.test BATCH +m2 metadata bob')).toBe(user);
  });

  it("does not let a peer's bare 761 end a LIST, only a SET's", () => {
    const { router, hear } = setup();
    const user = new Client();
    router.send(user, 'METADATA bob LIST');
    expect(hear(':irc.test 761 * bob avatar * :https://x/a.png')).toBe('unasked');
    router.send(user, 'METADATA * SET avatar :https://x/me.png');
    expect(hear(':irc.test 761 me me avatar * :https://x/me.png')).toBe(user);
  });
});

// A metadata query's replies are the lines tagged with ITS batch, not whatever
// arrives while the batch is open.
describe('METADATA replies and the batch tag', () => {
  it('leaves a bare 761 for someone else unasked while a LIST batch is open', () => {
    const { router, hear } = setup();
    const user = new Client();
    router.send(user, 'METADATA bob LIST');
    expect(hear(':irc.test BATCH +m1 metadata bob')).toBe(user);
    expect(hear(':irc.test 761 * carol avatar * :https://x/c.png')).toBe('unasked');
    expect(hear('@batch=m1 :irc.test 761 me bob display-name * :Bob')).toBe(user);
    // A different batch's line, interleaved, isn't its either.
    expect(hear('@batch=zz :irc.test 761 * dave status * :hi')).toBe('unasked');
    expect(hear(':irc.test BATCH -m1')).toBe(user);
  });
});
