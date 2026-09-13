// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The per-client line filter's rules, case by case. The same behaviour end to
// end, over a real socket, is in bouncer.integration.test.ts.

import { describe, it, expect } from 'vitest';
import {
  ClientLineFilter,
  formatLine,
  highestPrefixOnly,
  parseLine,
  restrictTags,
  whoFlagsHighestPrefixOnly,
} from './bouncerClientFilter.js';
import type { ClientView } from './bouncerClientFilter.js';

const PREFIXES = [
  { mode: 'q', symbol: '~' },
  { mode: 'o', symbol: '@' },
  { mode: 'v', symbol: '+' },
];

function filterFor(
  caps: string[],
  opts: { nick?: string; shared?: ReturnType<ClientView['sharedChannels']> } = {},
): ClientLineFilter {
  return new ClientLineFilter({
    caps: new Set(caps),
    serverName: 'lurker.bouncer',
    nick: () => opts.nick ?? 'me',
    prefixes: () => PREFIXES,
    sharedChannels: () => opts.shared ?? [],
  });
}

describe('parseLine / formatLine', () => {
  it.each([
    ':n!u@h PRIVMSG #c :hello world',
    '@time=2026-01-01T00:00:00.000Z;msgid=abc :n!u@h PRIVMSG #c :hi',
    ':irc.test 353 me = #c :@alice bob',
    ':irc.test 005 me CHANTYPES=# PREFIX=(ov)@+ :are supported by this server',
    ':n!u@h JOIN #c',
    'PING :irc.test',
    'AUTHENTICATE +',
    ':irc.test 001 me :',
    ':n!u@h PRIVMSG #c word',
  ])('round-trips %s', (line) => {
    expect(formatLine(parseLine(line)!)).toBe(line);
  });

  it('keeps a trailing param trailing when it no longer needs the colon', () => {
    const msg = parseLine(':irc.test 353 me = #c :@alice bob')!;
    msg.params[3] = '@alice';
    expect(formatLine(msg)).toBe(':irc.test 353 me = #c :@alice');
  });

  it('has no command for a bare tag block or source', () => {
    expect(parseLine('@time=x')).toBeNull();
    expect(parseLine(':irc.test')).toBeNull();
    expect(parseLine('')).toBeNull();
  });
});

const onlyTime = (key: string) => key === 'time';

describe('restrictTags', () => {
  it('keeps the tags asked for', () => {
    expect(restrictTags('@time=T;msgid=m :s 001 me :hi', onlyTime)).toBe('@time=T :s 001 me :hi');
  });

  it('drops an emptied tag block entirely', () => {
    expect(restrictTags('@msgid=m :s 001 me :hi', onlyTime)).toBe(':s 001 me :hi');
    expect(restrictTags('@ :s 001 me :hi', onlyTime)).toBe(':s 001 me :hi');
  });

  it('returns an untagged line unchanged', () => {
    const line = ':s  001 me :hi';
    expect(restrictTags(line, onlyTime)).toBe(line);
  });
});

describe('highestPrefixOnly / whoFlagsHighestPrefixOnly', () => {
  it('keeps the highest prefix of a NAMES entry', () => {
    expect(highestPrefixOnly('~@+alice', '~@+')).toBe('~alice');
    expect(highestPrefixOnly('+alice', '~@+')).toBe('+alice');
    expect(highestPrefixOnly('alice', '~@+')).toBe('alice');
    expect(highestPrefixOnly('@+alice', '')).toBe('@+alice');
  });

  it('keeps the highest prefix inside WHO flags', () => {
    expect(whoFlagsHighestPrefixOnly('H@+', '~@+')).toBe('H@');
    expect(whoFlagsHighestPrefixOnly('G*~@', '~@+')).toBe('G*~');
    expect(whoFlagsHighestPrefixOnly('H+', '~@+')).toBe('H+');
    expect(whoFlagsHighestPrefixOnly('H*', '~@+')).toBe('H*');
  });
});

describe('ClientLineFilter', () => {
  it('writes a line no rule touches byte-for-byte', () => {
    const line = ':n!u@h  PRIVMSG #c :hi';
    expect(filterFor([]).apply(line)).toEqual([line]);
  });

  // soju's SendMessage table. Without the cap the command never goes out; with
  // it, the line does.
  it.each([
    ['away-notify', ':n!u@h AWAY :gone to lunch'],
    ['away-notify', ':n!u@h AWAY'],
    ['account-notify', ':n!u@h ACCOUNT alice'],
    ['setname', ':n!u@h SETNAME :New Name'],
    ['message-tags', '@+typing=active :n!u@h TAGMSG #c'],
    ['draft/message-redaction', ':n!u@h REDACT #c abc'],
    ['draft/read-marker', ':irc.test MARKREAD #c timestamp=2026-01-01T00:00:00.000Z'],
    ['draft/metadata-2', ':irc.test METADATA me avatar * :https://example.test/a.png'],
    ['chghost', ':n!u@h CHGHOST u2 h2'],
  ])('sends a line gated on %s only to a client that has it', (cap, line) => {
    expect(filterFor([]).apply(line)).toEqual([]);
    expect(filterFor([cap]).apply(line)).toEqual([line]);
  });

  describe('INVITE', () => {
    it('without invite-notify, delivers only an invite for us', () => {
      const filter = filterFor([], { nick: 'Me' });
      expect(filter.apply(':op!o@h INVITE someone #c')).toEqual([]);
      expect(filter.apply(':op!o@h INVITE me #c')).toEqual([':op!o@h INVITE me #c']);
    });

    it('with invite-notify, delivers every invite', () => {
      const line = ':op!o@h INVITE someone #c';
      expect(filterFor(['invite-notify']).apply(line)).toEqual([line]);
    });
  });

  describe('JOIN', () => {
    it('trims the account and realname without extended-join', () => {
      expect(filterFor([]).apply(':n!u@h JOIN #c alice :Alice A')).toEqual([':n!u@h JOIN #c']);
      expect(filterFor(['server-time']).apply('@time=T :n!u@h JOIN #c * :Alice A')).toEqual([
        '@time=T :n!u@h JOIN #c',
      ]);
    });

    it('leaves an extended JOIN for a client that has extended-join', () => {
      const line = ':n!u@h JOIN #c alice :Alice A';
      expect(filterFor(['extended-join']).apply(line)).toEqual([line]);
    });
  });

  describe('NAMES (353)', () => {
    const line = ':irc.test 353 me = #c :~@+alice!a@h @bob!b@h carol!c@h';

    it('keeps one prefix and bare nicks for a client with neither cap', () => {
      expect(filterFor([]).apply(line)).toEqual([':irc.test 353 me = #c :~alice @bob carol']);
    });

    it('trims only what the client lacks', () => {
      expect(filterFor(['multi-prefix']).apply(line)).toEqual([
        ':irc.test 353 me = #c :~@+alice @bob carol',
      ]);
      expect(filterFor(['userhost-in-names']).apply(line)).toEqual([
        ':irc.test 353 me = #c :~alice!a@h @bob!b@h carol!c@h',
      ]);
      expect(filterFor(['multi-prefix', 'userhost-in-names']).apply(line)).toEqual([line]);
    });

    it('keeps a single entry trailing', () => {
      expect(filterFor([]).apply(':irc.test 353 me = #c :@+solo')).toEqual([
        ':irc.test 353 me = #c :@solo',
      ]);
    });
  });

  describe('WHO (352)', () => {
    const line = ':irc.test 352 me #c user host irc.test alice H*@+ :0 Alice A';

    it('keeps one prefix in the flags without multi-prefix', () => {
      expect(filterFor([]).apply(line)).toEqual([
        ':irc.test 352 me #c user host irc.test alice H*@ :0 Alice A',
      ]);
      expect(filterFor(['multi-prefix']).apply(line)).toEqual([line]);
    });
  });

  describe('tags', () => {
    const line = '@time=T;msgid=m;account=alice;+draft/react=x :n!u@h PRIVMSG #c :hi';

    it('keeps every tag for a message-tags client', () => {
      expect(filterFor(['message-tags']).apply(line)).toEqual([line]);
    });

    it('keeps only the tags whose own cap the client has, without message-tags', () => {
      expect(filterFor([]).apply(line)).toEqual([':n!u@h PRIVMSG #c :hi']);
      expect(filterFor(['server-time']).apply(line)).toEqual(['@time=T :n!u@h PRIVMSG #c :hi']);
      expect(filterFor(['server-time', 'account-tag']).apply(line)).toEqual([
        '@time=T;account=alice :n!u@h PRIVMSG #c :hi',
      ]);
    });

    it('drops an empty tag block for a client without message-tags', () => {
      expect(filterFor([]).apply('@ :n!u@h PRIVMSG #c :hi')).toEqual([':n!u@h PRIVMSG #c :hi']);
    });
  });

  describe('batches', () => {
    const netsplit = [
      ':irc.test BATCH +ns netsplit a.test b.test',
      '@batch=ns :carol!c@h QUIT :a.test b.test',
      ':irc.test BATCH -ns',
    ];

    it('passes a batch through to a client that has batch', () => {
      const filter = filterFor(['message-tags', 'batch']);
      expect(netsplit.flatMap((l) => filter.apply(l))).toEqual(netsplit);
    });

    it('keeps the batch tag for a batch client without message-tags', () => {
      const filter = filterFor(['batch']);
      expect(netsplit.flatMap((l) => filter.apply(l))).toEqual(netsplit);
    });

    it('never opens a batch for a client without batch, and strips the tag', () => {
      const filter = filterFor(['message-tags']);
      expect(netsplit.flatMap((l) => filter.apply(l))).toEqual([':carol!c@h QUIT :a.test b.test']);
    });

    it('strips the tag of a batch the client never saw start', () => {
      const filter = filterFor(['message-tags', 'batch']);
      expect(filter.apply('@batch=zz :carol!c@h QUIT :bye')).toEqual([':carol!c@h QUIT :bye']);
      expect(filter.apply(':irc.test BATCH -zz')).toEqual([]);
    });

    it('forgets open batches on resetBatches', () => {
      const filter = filterFor(['message-tags', 'batch']);
      filter.apply(netsplit[0]);
      filter.resetBatches();
      expect(filter.apply(netsplit[1])).toEqual([':carol!c@h QUIT :a.test b.test']);
      expect(filter.apply(netsplit[2])).toEqual([]);
    });

    // A client can give up batch part-way through one with CAP REQ :-batch.
    function filterWithCaps(caps: Set<string>): ClientLineFilter {
      return new ClientLineFilter({
        caps,
        serverName: 'lurker.bouncer',
        nick: () => 'me',
        prefixes: () => PREFIXES,
        sharedChannels: () => [],
      });
    }

    it('ends a batch for a client that gives up batch, even if it asks for it again', () => {
      const caps = new Set(['message-tags', 'batch']);
      const filter = filterWithCaps(caps);
      expect(filter.apply(netsplit[0])).toEqual([netsplit[0]]);
      caps.delete('batch');
      filter.forgetSentBatches();
      expect(filter.apply(netsplit[1])).toEqual([':carol!c@h QUIT :a.test b.test']);
      caps.add('batch');
      expect(filter.apply('@batch=ns :dave!d@h QUIT :a.test b.test')).toEqual([
        ':dave!d@h QUIT :a.test b.test',
      ]);
      expect(filter.apply(netsplit[2])).toEqual([]);
    });

    it('keeps no batch tag once the batch cap is gone, even before being told', () => {
      const caps = new Set(['message-tags', 'batch']);
      const filter = filterWithCaps(caps);
      filter.apply(netsplit[0]);
      caps.delete('batch');
      expect(filter.apply(netsplit[1])).toEqual([':carol!c@h QUIT :a.test b.test']);
    });

    it('drops the enclosing batch from unwrapped multiline lines once batch is given up', () => {
      const caps = new Set(['message-tags', 'batch']);
      const filter = filterWithCaps(caps);
      filter.apply(':irc.test BATCH +hist chathistory #c');
      filter.apply('@batch=hist;msgid=m1 :n!u@h BATCH +ml draft/multiline #c');
      caps.delete('batch');
      filter.forgetSentBatches();
      expect(filter.apply('@batch=ml :n!u@h PRIVMSG #c :one')).toEqual([
        '@msgid=m1 :n!u@h PRIVMSG #c :one',
      ]);
    });

    it('keeps a nested batch inside an open one', () => {
      const filter = filterFor(['message-tags', 'batch']);
      const lines = [
        ':irc.test BATCH +outer example.test/outer',
        '@batch=outer :irc.test BATCH +inner netjoin a.test b.test',
        '@batch=inner :carol!c@h JOIN #c',
        '@batch=outer :irc.test BATCH -inner',
        ':irc.test BATCH -outer',
      ];
      expect(lines.flatMap((l) => filter.apply(l))).toEqual(lines);
    });
  });

  // The spec's own example: draft/multiline, "Server sending messages to clients
  // without multiline support".
  describe('draft/multiline fallback', () => {
    const batch = [
      '@msgid=xxx;account=account :n!u@h BATCH +123 draft/multiline #channel',
      '@batch=123 :n!u@h PRIVMSG #channel hello',
      '@batch=123 :n!u@h PRIVMSG #channel :',
      '@batch=123 :n!u@h PRIVMSG #channel :how is ',
      '@batch=123;draft/multiline-concat :n!u@h PRIVMSG #channel :everyone?',
      'BATCH -123',
    ];

    it('sends the lines unbatched, without blanks, msgid on the first line only', () => {
      const filter = filterFor(['message-tags', 'batch']);
      expect(batch.flatMap((l) => filter.apply(l))).toEqual([
        '@msgid=xxx;account=account :n!u@h PRIVMSG #channel hello',
        '@account=account :n!u@h PRIVMSG #channel :how is ',
        '@account=account :n!u@h PRIVMSG #channel :everyone?',
      ]);
    });

    it('sends plain lines to a client without message-tags', () => {
      const filter = filterFor([]);
      expect(batch.flatMap((l) => filter.apply(l))).toEqual([
        ':n!u@h PRIVMSG #channel hello',
        ':n!u@h PRIVMSG #channel :how is ',
        ':n!u@h PRIVMSG #channel :everyone?',
      ]);
    });

    it('carries msgid to the first line that is not blank', () => {
      const filter = filterFor(['message-tags']);
      const lines = [
        '@msgid=m1 :n!u@h BATCH +b draft/multiline #c',
        '@batch=b :n!u@h PRIVMSG #c :',
        '@batch=b :n!u@h PRIVMSG #c :text',
        ':irc.test BATCH -b',
      ];
      expect(lines.flatMap((l) => filter.apply(l))).toEqual(['@msgid=m1 :n!u@h PRIVMSG #c :text']);
    });

    // A network's reconnect replay can hold a multiline message inside its
    // chathistory batch. Unwrapped, its lines still belong to that batch.
    it('keeps an enclosing batch the client was sent on the unwrapped lines', () => {
      const filter = filterFor(['message-tags', 'batch']);
      const lines = [
        ':irc.test BATCH +hist chathistory #c',
        '@batch=hist;msgid=m1;time=T :n!u@h BATCH +ml draft/multiline #c',
        '@batch=ml :n!u@h PRIVMSG #c :one',
        '@batch=ml :n!u@h PRIVMSG #c :two',
        '@batch=hist :irc.test BATCH -ml',
        ':irc.test BATCH -hist',
      ];
      expect(lines.flatMap((l) => filter.apply(l))).toEqual([
        ':irc.test BATCH +hist chathistory #c',
        '@batch=hist;msgid=m1;time=T :n!u@h PRIVMSG #c :one',
        '@batch=hist;time=T :n!u@h PRIVMSG #c :two',
        ':irc.test BATCH -hist',
      ]);
    });

    it("gives the lines their batch's time, not the time they were relayed", () => {
      const filter = filterFor(['message-tags', 'batch', 'server-time']);
      const relayedAt = new Date('2026-09-12T19:33:25.000Z');
      const lines = [
        '@msgid=m1;time=2026-01-01T00:00:00.000Z :n!u@h BATCH +b draft/multiline #c',
        '@batch=b :n!u@h PRIVMSG #c :one',
        '@batch=b :n!u@h PRIVMSG #c :two',
        ':irc.test BATCH -b',
      ];
      expect(lines.flatMap((l) => filter.apply(l, relayedAt))).toEqual([
        '@msgid=m1;time=2026-01-01T00:00:00.000Z :n!u@h PRIVMSG #c :one',
        '@time=2026-01-01T00:00:00.000Z :n!u@h PRIVMSG #c :two',
      ]);
    });
  });

  // soju stamps what it relays, so a server-time client has a time on every
  // message. apply() does it for a line given the time it was relayed.
  describe('time on relayed lines', () => {
    const relayedAt = new Date('2026-09-12T19:33:25.000Z');
    const stamp = 'time=2026-09-12T19:33:25.000Z';

    it('stamps a relayed line that has no time, for a server-time client', () => {
      const filter = filterFor(['server-time', 'message-tags']);
      expect(filter.apply(':n!u@h PRIVMSG #c :hi', relayedAt)).toEqual([
        `@${stamp} :n!u@h PRIVMSG #c :hi`,
      ]);
      expect(filter.apply('@msgid=m :n!u@h PRIVMSG #c :hi', relayedAt)).toEqual([
        `@${stamp};msgid=m :n!u@h PRIVMSG #c :hi`,
      ]);
    });

    it('leaves timed lines, numerics, unrelayed lines and other clients alone', () => {
      const filter = filterFor(['server-time']);
      const timed = '@time=T :n!u@h PRIVMSG #c :hi';
      expect(filter.apply(timed, relayedAt)).toEqual([timed]);
      expect(filter.apply(':irc.test 372 me :- welcome', relayedAt)).toEqual([
        ':irc.test 372 me :- welcome',
      ]);
      expect(filter.apply(':lurker.bouncer NOTICE me :hi')).toEqual([
        ':lurker.bouncer NOTICE me :hi',
      ]);
      expect(filterFor([]).apply(':n!u@h PRIVMSG #c :hi', relayedAt)).toEqual([
        ':n!u@h PRIVMSG #c :hi',
      ]);
    });

    it('stamps the CHGHOST fallback too, when the change has no time', () => {
      const filter = filterFor(['server-time'], { shared: [{ channel: '#ops', modes: [] }] });
      expect(filter.apply(':alice!old@old.host CHGHOST new new.host', relayedAt)).toEqual([
        `@${stamp} :alice!old@old.host QUIT :Changing hostname`,
        `@${stamp} :alice!new@new.host JOIN #ops`,
      ]);
    });
  });

  describe('CHGHOST fallback', () => {
    const shared = [
      { channel: '#ops', modes: ['v', 'o'] },
      { channel: '#lounge', modes: [] },
    ];
    const change = '@time=T;msgid=h1 :alice!old@old.host CHGHOST new new.host';

    it('sends the QUIT, JOIN and MODE the network would have sent', () => {
      expect(filterFor([], { shared }).apply(change)).toEqual([
        ':alice!old@old.host QUIT :Changing hostname',
        ':alice!new@new.host JOIN #ops',
        ':lurker.bouncer MODE #ops +ov alice alice',
        ':alice!new@new.host JOIN #lounge',
      ]);
    });

    it('stamps each fallback line with the change time for a server-time client', () => {
      expect(filterFor(['server-time'], { shared }).apply(change)).toEqual([
        '@time=T :alice!old@old.host QUIT :Changing hostname',
        '@time=T :alice!new@new.host JOIN #ops',
        '@time=T :lurker.bouncer MODE #ops +ov alice alice',
        '@time=T :alice!new@new.host JOIN #lounge',
      ]);
    });

    it('sends the fallback JOIN in extended form to an extended-join client', () => {
      const withAccounts = [
        { channel: '#ops', modes: [], account: 'alice' },
        { channel: '#lounge', modes: [], account: null },
      ];
      expect(filterFor(['extended-join'], { shared: withAccounts }).apply(change)).toEqual([
        ':alice!old@old.host QUIT :Changing hostname',
        ':alice!new@new.host JOIN #ops alice :',
        ':alice!new@new.host JOIN #lounge * :',
      ]);
    });

    it('sends nothing for our own change, or for a nick we share no channel with', () => {
      expect(filterFor([], { nick: 'Alice', shared }).apply(change)).toEqual([]);
      expect(filterFor([], { shared: [] }).apply(change)).toEqual([]);
    });
  });
});
