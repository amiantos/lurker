// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

// bouncer.js transitively imports ircManager → db/index.js, so the test DB
// path must be pinned before the dynamic import below touches it.
const ctx = setupTestDb('services-bouncer');

let parseClientLine: typeof import('./bouncer.js').parseClientLine;
let rebuildLine: typeof import('./bouncer.js').rebuildLine;
let parseBouncerCredentials: typeof import('./bouncer.js').parseBouncerCredentials;
let unmarshalLogin: typeof import('./bouncer.js').unmarshalLogin;
let rewriteNumericTarget: typeof import('./bouncer.js').rewriteNumericTarget;
let filterRelayLine: typeof import('./bouncer.js').filterRelayLine;
let memberPrefixSymbol: typeof import('./bouncer.js').memberPrefixSymbol;
let buildNamesLines: typeof import('./bouncer.js').buildNamesLines;
let isServicesNick: typeof import('./bouncer.js').isServicesNick;
let escapeTagValue: typeof import('./bouncer.js').escapeTagValue;
let buildNetworkAttrs: typeof import('./bouncer.js').buildNetworkAttrs;
let bouncerNetworkState: typeof import('./bouncer.js').bouncerNetworkState;
let maxSessionsPerUser: typeof import('./bouncer.js').maxSessionsPerUser;
let maxSessionsTotal: typeof import('./bouncer.js').maxSessionsTotal;
let maxTotalPlaybackLines: typeof import('./bouncer.js').maxTotalPlaybackLines;

beforeAll(async () => {
  const mod = await import('./bouncer.js');
  parseClientLine = mod.parseClientLine;
  rebuildLine = mod.rebuildLine;
  parseBouncerCredentials = mod.parseBouncerCredentials;
  unmarshalLogin = mod.unmarshalLogin;
  rewriteNumericTarget = mod.rewriteNumericTarget;
  filterRelayLine = mod.filterRelayLine;
  memberPrefixSymbol = mod.memberPrefixSymbol;
  buildNamesLines = mod.buildNamesLines;
  isServicesNick = mod.isServicesNick;
  escapeTagValue = mod.escapeTagValue;
  buildNetworkAttrs = mod.buildNetworkAttrs;
  bouncerNetworkState = mod.bouncerNetworkState;
  maxSessionsPerUser = mod.maxSessionsPerUser;
  maxSessionsTotal = mod.maxSessionsTotal;
  maxTotalPlaybackLines = mod.maxTotalPlaybackLines;
});

afterAll(() => ctx.cleanup());

describe('parseClientLine', () => {
  it('parses a simple command with params and trailing', () => {
    expect(parseClientLine('PRIVMSG #chan :hello world')).toEqual({
      command: 'PRIVMSG',
      params: ['#chan', 'hello world'],
    });
  });

  it('uppercases the command', () => {
    expect(parseClientLine('privmsg #chan :hi')?.command).toBe('PRIVMSG');
  });

  it('handles commands with no params', () => {
    expect(parseClientLine('QUIT')).toEqual({ command: 'QUIT', params: [] });
  });

  it('keeps an empty trailing param', () => {
    expect(parseClientLine('TOPIC #chan :')).toEqual({ command: 'TOPIC', params: ['#chan', ''] });
  });

  it('preserves colons inside the trailing param', () => {
    expect(parseClientLine('PRIVMSG #c :see: this')).toEqual({
      command: 'PRIVMSG',
      params: ['#c', 'see: this'],
    });
  });

  it('strips a client-supplied prefix', () => {
    expect(parseClientLine(':me!u@h PRIVMSG #c :hi')).toEqual({
      command: 'PRIVMSG',
      params: ['#c', 'hi'],
    });
  });

  it('strips client message tags', () => {
    expect(parseClientLine('@label=x;time=y PRIVMSG #c :hi')).toEqual({
      command: 'PRIVMSG',
      params: ['#c', 'hi'],
    });
  });

  it('strips CR/LF/NUL and rejects empty lines', () => {
    expect(parseClientLine('\r\n')).toBeNull();
    expect(parseClientLine('')).toBeNull();
    expect(parseClientLine('PING\r')).toEqual({ command: 'PING', params: [] });
  });

  it('handles PASS whose value contains a colon (not treated as trailing)', () => {
    expect(parseClientLine('PASS alice:hunter2')).toEqual({
      command: 'PASS',
      params: ['alice:hunter2'],
    });
  });
});

describe('rebuildLine', () => {
  it('round-trips a parsed line', () => {
    const parsed = parseClientLine('MODE #chan +o somebody')!;
    expect(rebuildLine(parsed)).toBe('MODE #chan +o somebody');
  });

  it('re-adds the trailing colon when the last param has spaces', () => {
    const parsed = parseClientLine('TOPIC #chan :new topic here')!;
    expect(rebuildLine(parsed)).toBe('TOPIC #chan :new topic here');
  });

  it('re-adds the trailing colon for an empty last param', () => {
    expect(rebuildLine({ command: 'TOPIC', params: ['#chan', ''] })).toBe('TOPIC #chan :');
  });

  it('handles a bare command', () => {
    expect(rebuildLine({ command: 'LUSERS', params: [] })).toBe('LUSERS');
  });
});

describe('unmarshalLogin (soju unmarshalUsername parity)', () => {
  // Cases mirror soju's downstream_test.go / unmarshalUsername semantics: `/`
  // selects the network, `@` a per-device client id, and the FIRST separator
  // bounds the username — `/` and `@` may appear in either order.
  const cases: Array<
    [string, { username: string; network: string | null; client: string | null }]
  > = [
    ['user', { username: 'user', network: null, client: null }],
    ['user/network', { username: 'user', network: 'network', client: null }],
    ['user@client', { username: 'user', network: null, client: 'client' }],
    ['user/network@client', { username: 'user', network: 'network', client: 'client' }],
    ['user@client/network', { username: 'user', network: 'network', client: 'client' }],
    // Only the first separator bounds the username; trailing empties collapse.
    ['user/', { username: 'user', network: null, client: null }],
    ['user@', { username: 'user', network: null, client: null }],
    ['', { username: '', network: null, client: null }],
  ];
  for (const [raw, expected] of cases) {
    it(`parses ${JSON.stringify(raw)}`, () => {
      expect(unmarshalLogin(raw)).toEqual(expected);
    });
  }
});

describe('parseBouncerCredentials', () => {
  it('parses user:secret', () => {
    expect(parseBouncerCredentials('alice:hunter2', null)).toEqual({
      username: 'alice',
      secret: 'hunter2',
      network: null,
    });
  });

  it('parses user/network:secret', () => {
    expect(parseBouncerCredentials('alice/libera:hunter2', null)).toEqual({
      username: 'alice',
      secret: 'hunter2',
      network: 'libera',
    });
  });

  it('keeps colons inside the secret (API tokens can contain none, passwords may)', () => {
    expect(parseBouncerCredentials('alice:pa:ss:word', null)?.secret).toBe('pa:ss:word');
  });

  it('falls back to the USER field for the login when PASS is only the secret', () => {
    expect(parseBouncerCredentials('hunter2', 'alice/libera')).toEqual({
      username: 'alice',
      secret: 'hunter2',
      network: 'libera',
    });
  });

  it('picks the network from USER when PASS carried only user:secret', () => {
    expect(parseBouncerCredentials('alice:hunter2', 'alice/libera')?.network).toBe('libera');
  });

  it('discards a ZNC-style @clientid', () => {
    expect(parseBouncerCredentials('alice@phone/libera:hunter2', null)).toEqual({
      username: 'alice',
      secret: 'hunter2',
      network: 'libera',
    });
  });

  it('extracts the network when @clientid comes AFTER /network (soju order)', () => {
    // The pre-Phase-2 parser split on `/` first and leaked `@phone` into the
    // network; unmarshalLogin honors soju's first-separator rule instead.
    expect(parseBouncerCredentials('alice/libera@phone:hunter2', null)).toEqual({
      username: 'alice',
      secret: 'hunter2',
      network: 'libera',
    });
  });

  it('rejects a missing login or secret', () => {
    expect(parseBouncerCredentials('', null)).toBeNull();
    expect(parseBouncerCredentials('secretonly', null)).toBeNull();
    expect(parseBouncerCredentials(':nouser', null)).toBeNull();
    expect(parseBouncerCredentials('alice:', null)).toBeNull();
  });
});

describe('rewriteNumericTarget', () => {
  it('replaces the target nick of a numeric', () => {
    expect(rewriteNumericTarget(':irc.libera.chat 001 oldnick :Welcome to Libera', 'newnick')).toBe(
      ':irc.libera.chat 001 newnick :Welcome to Libera',
    );
  });

  it('preserves ISUPPORT tokens after the nick', () => {
    expect(
      rewriteNumericTarget(
        ':server 005 old CHANTYPES=# PREFIX=(ov)@+ :are supported by this server',
        'me',
      ),
    ).toBe(':server 005 me CHANTYPES=# PREFIX=(ov)@+ :are supported by this server');
  });

  it('returns unprefixed lines unchanged', () => {
    expect(rewriteNumericTarget('PING :x', 'me')).toBe('PING :x');
  });

  it('still rewrites when the line carries a stray trailing CR', () => {
    expect(rewriteNumericTarget(':server 001 old :Welcome\r', 'me')).toBe(
      ':server 001 me :Welcome\r',
    );
  });
});

describe('filterRelayLine', () => {
  const noCaps = new Set<string>();

  it('passes ordinary conversation through untouched', () => {
    const line = ':nick!u@h PRIVMSG #chan :hello';
    expect(filterRelayLine(line, noCaps)).toBe(line);
  });

  it('strips the trailing CR irc-framework leaves on raw lines', () => {
    expect(filterRelayLine(':nick!u@h PRIVMSG #chan :hello\r', noCaps)).toBe(
      ':nick!u@h PRIVMSG #chan :hello',
    );
  });

  it('drops connection plumbing', () => {
    expect(filterRelayLine('PING :irc.libera.chat', noCaps)).toBeNull();
    expect(filterRelayLine(':irc.libera.chat PONG server :token', noCaps)).toBeNull();
    expect(filterRelayLine(':irc.libera.chat CAP * LS :sasl', noCaps)).toBeNull();
    expect(filterRelayLine('AUTHENTICATE +', noCaps)).toBeNull();
    expect(filterRelayLine('ERROR :Closing Link', noCaps)).toBeNull();
    expect(filterRelayLine(':server 001 me :Welcome', noCaps)).toBeNull();
    expect(filterRelayLine(':server 005 me CHANTYPES=# :are supported', noCaps)).toBeNull();
    expect(filterRelayLine(':server 903 me :SASL successful', noCaps)).toBeNull();
  });

  it('relays MOTD and other numerics', () => {
    const line = ':server 372 me :- welcome to the network';
    expect(filterRelayLine(line, noCaps)).toBe(line);
  });

  it('strips all tags for a capless client', () => {
    expect(filterRelayLine('@time=2026-01-01T00:00:00.000Z :n!u@h PRIVMSG #c :hi', noCaps)).toBe(
      ':n!u@h PRIVMSG #c :hi',
    );
  });

  it('keeps only the time tag for a server-time client', () => {
    const caps = new Set(['server-time']);
    expect(
      filterRelayLine('@msgid=abc;time=2026-01-01T00:00:00.000Z :n!u@h PRIVMSG #c :hi', caps),
    ).toBe('@time=2026-01-01T00:00:00.000Z :n!u@h PRIVMSG #c :hi');
  });

  it('keeps every tag for a message-tags client', () => {
    const caps = new Set(['message-tags']);
    const line = '@msgid=abc;time=x :n!u@h PRIVMSG #c :hi';
    expect(filterRelayLine(line, caps)).toBe(line);
  });

  it('drops TAGMSG and BATCH unless the client negotiated message-tags', () => {
    expect(filterRelayLine('@+typing=active :n!u@h TAGMSG #c', noCaps)).toBeNull();
    expect(filterRelayLine(':server BATCH +ref draft/multiline #c', noCaps)).toBeNull();
    const caps = new Set(['message-tags']);
    expect(filterRelayLine('@+typing=active :n!u@h TAGMSG #c', caps)).toBe(
      '@+typing=active :n!u@h TAGMSG #c',
    );
  });
});

describe('isServicesNick', () => {
  it('matches network-services pseudo-users regardless of case', () => {
    for (const n of [
      'NickServ',
      'chanserv',
      'MemoServ',
      'HostServ',
      'OperServ',
      'SaslServ',
      'Global',
    ]) {
      expect(isServicesNick(n)).toBe(true);
    }
  });

  it('matches well-known non-*serv auth bots regardless of case', () => {
    // QuakeNet Q, Undernet X/W, and AuthServ (caught by the *serv rule).
    for (const n of ['Q', 'q', 'X', 'W', 'AuthServ']) {
      expect(isServicesNick(n)).toBe(true);
    }
  });

  it('leaves ordinary nicks alone', () => {
    for (const n of ['bob', 'serv', 'nickservv', 'server1', 'preserve1', 'quinn', 'xavier']) {
      expect(isServicesNick(n)).toBe(false);
    }
  });
});

describe('escapeTagValue (IRCv3 message-tag escaping)', () => {
  it('escapes space, semicolon, backslash, CR and LF', () => {
    expect(escapeTagValue('My Awesome Network')).toBe('My\\sAwesome\\sNetwork');
    expect(escapeTagValue('a;b')).toBe('a\\:b');
    expect(escapeTagValue('a\\b')).toBe('a\\\\b');
    expect(escapeTagValue('a\r\nb')).toBe('a\\r\\nb');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeTagValue('libera.chat')).toBe('libera.chat');
  });
});

describe('buildNetworkAttrs', () => {
  const network = { name: 'Libera Chat', host: 'irc.libera.chat', port: 6697, tls: 1, nick: 'me' };

  it('encodes the network as a tag-escaped attribute list', () => {
    expect(buildNetworkAttrs(network, { state: 'connected' })).toBe(
      'name=Libera\\sChat;state=connected;host=irc.libera.chat;port=6697;tls=1;nickname=me',
    );
  });

  it('reports the given state and honors a live nickname override', () => {
    const attrs = buildNetworkAttrs(network, { state: 'disconnected', nickname: 'me_' });
    expect(attrs).toContain('state=disconnected');
    expect(attrs).toContain('nickname=me_');
  });
});

describe('bouncerNetworkState', () => {
  it('maps upstream states to spec values (connecting/reconnecting → connecting)', () => {
    expect(bouncerNetworkState('connected')).toBe('connected');
    expect(bouncerNetworkState('connecting')).toBe('connecting');
    expect(bouncerNetworkState('reconnecting')).toBe('connecting');
    expect(bouncerNetworkState('disconnected')).toBe('disconnected');
    expect(bouncerNetworkState(undefined)).toBe('disconnected');
  });
});

describe('memberPrefixSymbol', () => {
  it('maps the highest-ranked mode to its symbol', () => {
    expect(memberPrefixSymbol(['v', 'o'])).toBe('@');
    expect(memberPrefixSymbol(['v'])).toBe('+');
    expect(memberPrefixSymbol([])).toBe('');
  });

  it('honors a network-supplied prefix table', () => {
    const prefixes = [
      { mode: 'y', symbol: '!' },
      { mode: 'o', symbol: '@' },
    ];
    expect(memberPrefixSymbol(['y'], prefixes)).toBe('!');
    expect(memberPrefixSymbol(['q'], prefixes)).toBe('');
  });
});

describe('buildNamesLines', () => {
  it('emits a 353 with members and a 366 terminator', () => {
    const lines = buildNamesLines('me', '#chan', ['@op', '+voice', 'plain']);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(':lurker.bouncer 353 me = #chan :@op +voice plain');
    expect(lines[1]).toBe(':lurker.bouncer 366 me #chan :End of /NAMES list.');
  });

  it('emits only the terminator for an empty channel', () => {
    const lines = buildNamesLines('me', '#chan', []);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('366');
  });

  it('chunks large member lists under the wire cap', () => {
    const names = Array.from({ length: 200 }, (_, i) => `member${i}`);
    const lines = buildNamesLines('me', '#chan', names);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(0, -1)) {
      expect(line.length).toBeLessThanOrEqual(510);
      expect(line).toContain('353');
    }
    // Every member appears exactly once across the chunks.
    const all = lines
      .slice(0, -1)
      .map((l) => l.split(' :')[1])
      .join(' ')
      .split(' ');
    expect(all).toHaveLength(200);
    expect(new Set(all).size).toBe(200);
  });
});

describe('maxSessionsPerUser / maxSessionsTotal', () => {
  const perUserKey = 'LURKER_BOUNCER_MAX_SESSIONS_PER_USER';
  const totalKey = 'LURKER_BOUNCER_MAX_SESSIONS';
  let savedPerUser: string | undefined;
  let savedTotal: string | undefined;
  beforeAll(() => {
    savedPerUser = process.env[perUserKey];
    savedTotal = process.env[totalKey];
  });
  afterAll(() => {
    if (savedPerUser === undefined) delete process.env[perUserKey];
    else process.env[perUserKey] = savedPerUser;
    if (savedTotal === undefined) delete process.env[totalKey];
    else process.env[totalKey] = savedTotal;
  });

  it('defaults to 32 per-user and 512 total when unset', () => {
    delete process.env[perUserKey];
    delete process.env[totalKey];
    expect(maxSessionsPerUser()).toBe(32);
    expect(maxSessionsTotal()).toBe(512);
  });

  it('reads positive integers from env', () => {
    process.env[perUserKey] = '4';
    process.env[totalKey] = '100';
    expect(maxSessionsPerUser()).toBe(4);
    expect(maxSessionsTotal()).toBe(100);
  });

  it('falls back to the default for non-positive or garbage values', () => {
    process.env[perUserKey] = '0';
    expect(maxSessionsPerUser()).toBe(32);
    process.env[perUserKey] = '-5';
    expect(maxSessionsPerUser()).toBe(32);
    process.env[totalKey] = 'nope';
    expect(maxSessionsTotal()).toBe(512);
  });
});

describe('maxTotalPlaybackLines', () => {
  const key = 'LURKER_BOUNCER_MAX_PLAYBACK_TOTAL';
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env[key];
  });
  afterAll(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });

  it('defaults to 10000 when unset', () => {
    delete process.env[key];
    expect(maxTotalPlaybackLines()).toBe(10000);
  });

  it('reads a positive integer and rejects non-positive/garbage', () => {
    process.env[key] = '2500';
    expect(maxTotalPlaybackLines()).toBe(2500);
    process.env[key] = '0';
    expect(maxTotalPlaybackLines()).toBe(10000);
    process.env[key] = 'nope';
    expect(maxTotalPlaybackLines()).toBe(10000);
  });
});
