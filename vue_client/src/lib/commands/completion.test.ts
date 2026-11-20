// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  completionContext,
  candidatesFor,
  argKind,
  isComplete,
  usageHint,
  type Candidate,
  type CompletionContext,
} from './completion.js';
import { specFor } from './registry.js';
import type { Alias } from '../../../../shared/aliases.js';

// What the caret is sitting in, and the token a pick replaces. The first three
// groups are the mobile apps' CommandCompletionTests, case for case, so the two
// classifiers answer alike where they overlap; the rest is what only the web
// completes.

function arg(value: string, caret = value.length) {
  const ctx = completionContext(value, caret);
  if (ctx?.type !== 'argument') throw new Error(`no argument context for ${value}`);
  return ctx;
}
const shape = (c: CompletionContext) =>
  c.type === 'command'
    ? { query: c.query, start: c.start, end: c.end }
    : { verb: c.verb, index: c.index, kind: c.kind, query: c.query, start: c.start, end: c.end };
const values = (value: string, live?: Parameters<typeof candidatesFor>[1]) => {
  const ctx = completionContext(value, value.length);
  return ctx ? candidatesFor(ctx, live).map((c) => c.value) : null;
};

describe('command name', () => {
  it('a bare slash offers every command', () => {
    expect(completionContext('/', 1)).toEqual({ type: 'command', query: '', start: 0, end: 1 });
  });

  it('a leading space or line is not a command', () => {
    expect(completionContext(' /jo', 4)).toBeNull();
    expect(completionContext('\n/join #l', 9)).toBeNull();
  });

  it('typing the verb filters commands', () => {
    expect(completionContext('/jo', 3)).toEqual({ type: 'command', query: 'jo', start: 0, end: 3 });
  });

  it('a caret mid-verb swallows the whole verb token', () => {
    expect(completionContext('/join', 3)).toEqual({
      type: 'command',
      query: 'jo',
      start: 0,
      end: 5,
    });
  });

  it('a caret on the slash has nothing to complete', () => {
    expect(completionContext('/join', 0)).toBeNull();
  });
});

describe('channel and nick arguments', () => {
  it('the channel argument under the caret', () => {
    expect(shape(arg('/join #li'))).toEqual({
      verb: 'join',
      index: 0,
      kind: 'channel',
      query: '#li',
      start: 6,
      end: 9,
    });
  });

  it('an empty channel slot after the space', () => {
    expect(shape(arg('/join '))).toEqual({
      verb: 'join',
      index: 0,
      kind: 'channel',
      query: '',
      start: 6,
      end: 6,
    });
  });

  it('a channel argument mid-word swallows the tail', () => {
    expect(shape(arg('/join #linux', 9))).toMatchObject({ query: '#li', start: 6, end: 12 });
  });

  it('the nick argument under the caret', () => {
    expect(shape(arg('/msg al'))).toEqual({
      verb: 'msg',
      index: 0,
      kind: 'nick',
      query: 'al',
      start: 5,
      end: 7,
    });
  });

  it("invite's second argument is a channel", () => {
    expect(shape(arg('/invite bob #'))).toMatchObject({ index: 1, kind: 'channel', query: '#' });
  });

  it('a leading channel picks the channel-first form', () => {
    expect(arg('/invite #ot').kind).toBe('channel');
    expect(arg('/invite #chan b').kind).toBe('nick');
    expect(arg('/kick &local b').kind).toBe('nick');
    expect(arg('/op #chan a b').kind).toBe('nick');
  });

  it('a rest slot keeps answering past the end', () => {
    expect(shape(arg('/op a b c'))).toMatchObject({ index: 2, kind: 'nick', query: 'c', start: 8 });
  });

  it('an alias completes as the command it names', () => {
    expect(arg('/j #li')).toMatchObject({ verb: 'j', kind: 'channel' });
    expect(arg('/j #li').spec).toBe(specFor('join'));
  });
});

describe('no completion', () => {
  it.each([
    ['a free-text slot', '/me hello'],
    ['a channel key', '/join #x k'],
    ['your new nick', '/nick bo'],
    ['an unknown verb', '/frob x'],
    ['an escape', '//slap'],
    ['plain text', 'hello'],
    ['the body of a message', '/msg alice hel'],
    ["a flag's own value", '/ignore -time 5'],
  ])('%s yields nothing', (_name, value) => {
    expect(completionContext(value, value.length)).toBeNull();
  });
});

describe('commands as candidates', () => {
  it('matches a prefix on names, canonical first', () => {
    expect(values('/j')).toEqual(['/j', '/jitsi']);
    expect(values('/ji')).toEqual(['/jitsi']);
  });

  it('shows an alias once, under the alias, when only the alias matches', () => {
    const ctx = completionContext('/ho', 3)!;
    expect(candidatesFor(ctx)).toEqual([
      { value: '/hop', label: '/hop [reason]', detail: 'alias of /cycle', kind: 'command' },
    ]);
    // `/query` is `/msg`: one row, not two.
    expect(values('/q')).toEqual(['/quiet', '/quit', '/query', '/quote']);
  });

  it('a bare slash leads with the starter set and lists everything', () => {
    const all = values('/')!;
    expect(all.slice(0, 6)).toEqual(['/join', '/msg', '/me', '/nick', '/topic', '/away']);
    expect(all).toContain('/xdcc');
    expect(new Set(all).size).toBe(all.length);
  });

  it('never lists a hidden command, and still completes inside it', () => {
    expect(values('/sh')).toEqual(['/shrug']);
    expect(values('/sheep sc')).toEqual(['scale']);
  });

  it('the system buffer lists only what runs without a network', () => {
    const ctx = completionContext('/', 1)!;
    const names = candidatesFor(ctx, { agnosticOnly: true }).map((c) => c.value);
    expect(names).toContain('/network');
    expect(names).toContain('/away');
    expect(names).not.toContain('/join');
  });
});

describe('subcommands', () => {
  it('an empty slot offers the keyword of every form', () => {
    expect(values('/theme ')).toEqual(['list', 'apply', 'save', 'delete', 'mode', 'use']);
  });

  it('filters by what is typed, and carries the form as the row', () => {
    const ctx = completionContext('/dcc c', 6)!;
    expect(candidatesFor(ctx).map((c) => [c.value, c.label])).toEqual([
      ['cancel', '/dcc cancel <id>'],
      ['clear', '/dcc clear [id]'],
      ['chat', '/dcc chat [-passive] [-secure] <nick>'],
      ['close', '/dcc close chat <nick>'],
    ]);
  });

  it('a keyword picks its form for what follows', () => {
    expect(arg('/dcc chat b').kind).toBe('nick');
    expect(arg('/dcc close ').slots).toMatchObject([{ type: 'keyword', value: 'chat' }]);
    expect(arg('/dcc close chat b').kind).toBe('nick');
    expect(values('/e2e autotrust ')).toEqual(['list', 'add', 'remove']);
    expect(completionContext('/dcc accept 3', 13)).toBeNull();
  });

  it("reads a keyword's other spellings without offering them", () => {
    expect(values('/theme d')).toEqual(['delete']);
    expect(arg('/theme rm Oce').kind).toBe('theme');
  });

  it('is not case sensitive', () => {
    expect(values('/DCC CH')).toEqual(['chat']);
    expect(arg('/dcc CHAT b').kind).toBe('nick');
  });
});

describe('flags', () => {
  it('are offered once a dash is typed, not before', () => {
    expect(completionContext('/away ', 6)).toBeNull();
    expect(values('/away -')).toEqual(['-all', '-one']);
    expect(values('/back -o')).toEqual(['-one']);
  });

  it('do not count as positionals', () => {
    expect(arg('/dcc chat -passive b').kind).toBe('nick');
    expect(arg('/dcc send -secure -passive b').kind).toBe('nick');
    expect(arg('/ignore -network -time 5m bo')).toMatchObject({ kind: 'nick', query: 'bo' });
  });

  it('may follow the positionals', () => {
    expect(values('/network modify libera -sasl')).toEqual(['-sasl_username', '-sasl_password']);
  });

  it('a dash that is no flag of the command is an ordinary token', () => {
    // `/accept -bob` takes bob off the list; `/ignore bob -PUBLIC` subtracts a level.
    expect(arg('/accept -bo').kind).toBe('nick');
    expect(arg('/op -x b').kind).toBe('nick');
  });
});

describe('choices and live lists', () => {
  it('a fixed list completes case-insensitively and inserts as written', () => {
    expect(values('/ctcp bob ve')).toEqual(['VERSION']);
    expect(values('/ignore bob noh')).toEqual(['NOHIGHLIGHT']);
    expect(values('/ignore bob JOINS pa')).toEqual(['PARTS']);
    expect(values('/theme use ')).toEqual(['light', 'dark']);
    expect(values('/e2e on #chan q')).toEqual(['quiet']);
  });

  it('a live slot asks the composer, with what came before it', () => {
    const calls: unknown[] = [];
    const live = (kind: string, query: string, preceding: readonly string[]): Candidate[] => {
      calls.push([kind, query, preceding]);
      return [{ value: 'x', kind: 'setting' }];
    };
    expect(values('/set inp', { live })).toEqual(['x']);
    expect(values('/set input.foo tr', { live })).toEqual(['x']);
    expect(values('/network connect lib', { live })).toEqual(['x']);
    expect(calls).toEqual([
      ['setting', 'inp', []],
      ['settingValue', 'tr', ['input.foo']],
      ['network', 'lib', ['connect']],
    ]);
  });

  it('a name that can hold spaces completes as one value to the end of the line', () => {
    expect(shape(arg('/theme apply My Th'))).toMatchObject({
      kind: 'theme',
      query: 'My Th',
      start: 13,
      end: 18,
    });
    expect(shape(arg('/theme use dark Monokai Plus L'))).toMatchObject({ query: 'Monokai Plus L' });
    expect(shape(arg('/avatars use '))).toMatchObject({ kind: 'avatarSet', query: '', start: 13 });
    // A run of nicks is still one nick at a time.
    expect(shape(arg('/op a b'))).toMatchObject({ query: 'b' });
  });
});

describe('argKind', () => {
  it('reads the typed words rather than counting them', () => {
    const dcc = specFor('dcc')!;
    expect(argKind(dcc, ['chat'])).toBe('nick');
    expect(argKind(dcc, ['chat', '-passive'])).toBe('nick');
    expect(argKind(dcc, ['close', 'chat'])).toBe('nick');
    expect(argKind(dcc, ['frob'])).toBeNull();
    expect(argKind(specFor('msg')!, ['#chan'], 'hi')).toBe('text');
  });
});

const complete = (value: string) => {
  const ctx = completionContext(value, value.length)!;
  return isComplete(ctx, candidatesFor(ctx));
};

describe('isComplete', () => {
  it('a whole command name or alias sends', () => {
    expect(complete('/away')).toBe(true);
    expect(complete('/j')).toBe(true);
    expect(complete('/aw')).toBe(false);
  });

  it('a whole keyword sends, part of one completes', () => {
    expect(complete('/dcc list')).toBe(true);
    expect(complete('/dcc li')).toBe(false);
    expect(complete('/ctcp bob version')).toBe(true);
  });

  it('nothing typed in a slot sends', () => {
    expect(complete('/part ')).toBe(true);
    expect(complete('/dcc ')).toBe(true);
  });
});

describe('review fixes', () => {
  it('a name or alias typed in full leads', () => {
    expect(values('/who')?.[0]).toBe('/who');
    expect(values('/hop')).toEqual(['/hop']);
  });

  it('a value with spaces is whole with the space a pick left after it', () => {
    const live = () =>
      ['Monokai Plus', 'Monokai Plus Light'].map((value): Candidate => ({ value, kind: 'theme' }));
    const ctx = arg('/theme apply Monokai Plus ');
    expect(isComplete(ctx, candidatesFor(ctx, { live }))).toBe(true);
  });

  it('options that only lead are not offered after the text', () => {
    expect(values('/away -a')).toEqual(['-all']);
    expect(values('/away brb -a')).toBeNull();
    expect(values('/ignore bob -n')).toEqual(['-network']);
  });

  it('a word in an optional channel slot is the text after it', () => {
    expect(completionContext('/topic Lurker', 13)).toBeNull();
    expect(completionContext('/part lunch', 11)).toBeNull();
    expect(arg('/part #lu').kind).toBe('channel');
    expect(arg('/part ').kind).toBe('channel');
    expect(arg('/join li').kind).toBe('channel');
  });

  it('reads quotes where the command does', () => {
    const ctx = arg('/network modify "My Net" -');
    expect(ctx.preceding).toEqual(['modify', '"My Net"']);
    expect(ctx.query).toBe('-');
    expect(arg('/network connect "My N').query).toBe('"My N');
    // Nowhere else: a quote in a message is a quote.
    expect(arg('/op "bob al').query).toBe('al');
  });
});

describe('options where the handler reads them', () => {
  it('/dcc send takes them ahead of the nick, /dcc chat anywhere', () => {
    expect(values('/dcc send -se')).toEqual(['-secure']);
    expect(values('/dcc send -passive -se')).toEqual(['-secure']);
    expect(values('/dcc send bob -se')).toBeNull();
    expect(values('/dcc chat bob -se')).toEqual(['-secure']);
  });

  it('/away takes one, first', () => {
    expect(values('/away -')).toEqual(['-all', '-one']);
    expect(values('/away -all -o')).toBeNull();
  });

  it('other spellings are stepped over, not offered', () => {
    expect(arg('/ignore -net al').kind).toBe('nick');
    expect(values('/ignore -ne')).toEqual(['-network']);
    expect(arg('/e2e hs al').kind).toBe('nick');
  });

  it('a quoted pattern and a two-word duration are one value each', () => {
    expect(arg('/ignore -pattern "foo bar" al').kind).toBe('nick');
    expect(arg('/ignore -time 7 days al').kind).toBe('nick');
    expect(arg('/ignore -time 5m al').kind).toBe('nick');
  });

  it('nothing is an option after --', () => {
    expect(values('/highlight -n')).toEqual(['-network']);
    expect(values('/highlight -- -n')).toBeNull();
  });

  it('only a new network takes -channel and -cert', () => {
    expect(values('/network add x -c')).toEqual(['-channel', '-cert']);
    expect(values('/network modify x -c')).toEqual([]);
    expect(values('/network modify x -pr')).toEqual(['-proxy']);
  });

  it('/e2e on completes a mode with the channel left out', () => {
    expect(values('/e2e on q')).toEqual(['quiet']);
    expect(values('/e2e on #chan q')).toEqual(['quiet']);
  });
});

describe("the user's own aliases (#276)", () => {
  const aliases = [
    { name: 'j2', body: '/join' },
    { name: 'jchat', body: 'dcc chat' },
    { name: 'quit', body: '/quit gone fishing' },
    { name: 'wii', body: '/whois $1 $1' },
    { name: 'both', body: '/part; /join' },
    { name: 'far', body: '/j2' },
  ];
  const own = (value: string, caret = value.length) => completionContext(value, caret, aliases);
  const rows = (value: string) => candidatesFor(own(value)!, { aliases });

  it('lists them with the commands, a name typed in full first', () => {
    expect(rows('/j').map((c) => c.value)).toEqual(['/j', '/jitsi', '/j2', '/jchat']);
    expect(rows('/j2').map((c) => c.value)).toEqual(['/j2']);
    expect(rows('/wi')).toEqual([{ value: '/wii', detail: '→ /whois $1 $1', kind: 'command' }]);
  });

  it('lists one in place of the command it replaces', () => {
    expect(rows('/quit')).toEqual([
      { value: '/quit', detail: '→ /quit gone fishing', kind: 'command' },
    ]);
  });

  it('a whole alias name sends', () => {
    const complete = (value: string) => isComplete(own(value)!, rows(value));
    expect(complete('/wii')).toBe(true);
    expect(complete('/wi')).toBe(false);
  });

  it('completes the arguments of a plain rename as the command it stands for', () => {
    expect(own('/j2 #li')).toMatchObject({ verb: 'join', kind: 'channel', query: '#li', index: 0 });
  });

  it('counts the words its body already supplies', () => {
    // `/jchat ` is `/dcc chat `: past the keyword, at the nick.
    expect(own('/jchat bo')).toMatchObject({ verb: 'dcc', kind: 'nick', query: 'bo', index: 1 });
    // A reason is free text, so there is nothing to offer.
    expect(own('/quit lat')).toBeNull();
  });

  it('offers nothing where a typed word has no one slot, or the body is another alias', () => {
    expect(own('/wii bo')).toBeNull();
    expect(own('/both #a')).toBeNull();
    expect(own('/far #a')).toBeNull();
  });

  it('offers nothing when the command it names is itself replaced', () => {
    const replaced = [...aliases, { name: 'join', body: '/msg bob $*' }];
    expect(completionContext('/j2 #li', 7, replaced)).toBeNull();
    // Its own name in its body is still the command.
    expect(completionContext('/join #li', 9, [{ name: 'join', body: '/join' }])).toMatchObject({
      verb: 'join',
      kind: 'channel',
    });
  });

  it('leaves commands alone when there are no aliases', () => {
    expect(completionContext('/join #li', 9)).toMatchObject({ verb: 'join', kind: 'channel' });
  });
});

// The line kept in view while the arguments are typed (#1369): the usage as
// text, with the word under the caret in brackets here.
describe('the usage line', () => {
  const line = (value: string, caret = value.length, aliases: Alias[] = []) => {
    const hint = usageHint(value, caret, aliases);
    return hint && hint.parts.map((p) => (p.active ? `{${p.text}}` : p.text)).join(' ');
  };

  it('is absent while the verb is typed, and for no command', () => {
    expect(line('/ki')).toBeNull();
    expect(line('/kick')).toBeNull();
    expect(line('/nosuchverb a b')).toBeNull();
    expect(line('//kick bob')).toBeNull();
    expect(line('hello there')).toBeNull();
  });

  it('marks the argument under the caret, and follows it along the line', () => {
    expect(line('/kick ')).toBe('/kick {<nick>} [reason]');
    expect(line('/kick bo')).toBe('/kick {<nick>} [reason]');
    expect(line('/kick bob ')).toBe('/kick <nick> {[reason]}');
    expect(line('/kick bob spamming the channel')).toBe('/kick <nick> {[reason]}');
    expect(line('/kick bob spam', 8)).toBe('/kick {<nick>} [reason]');
  });

  it('stays for text nothing completes', () => {
    expect(completionContext('/me waves', 9)).toBeNull();
    expect(line('/me waves')).toBe('/me {<text>}');
  });

  it('shows the word order the line fits', () => {
    expect(line('/kick #ops bo')).toBe('/kick <#chan> {<nick>} [reason]');
    expect(line('/invite #ops ')).toBe(line('/invite #ops x'));
    expect(line('/invite #ops ')).not.toBe(line('/invite '));
  });

  it('shows the family while a subcommand is chosen, then that subcommand', () => {
    expect(line('/dcc ')).toBe('/dcc [list]');
    expect(line('/dcc se')).toBe('/dcc [list]');
    expect(line('/dcc send ')).toBe('/dcc send [-passive] [-secure] {<nick>} [file]');
    expect(usageHint('/dcc send ', 10)?.summary).toBe(
      'send one of your files; with no file, pick or upload one',
    );
    expect(usageHint('/dcc ', 5)?.summary).toBe('DCC transfers and direct chats');
    expect(line('/dcc close ')).toBe('/dcc close {chat} <nick>');
  });

  it('marks the options while one is typed, and the one whose value is', () => {
    expect(line('/dcc send -')).toBe('/dcc send {[-passive]} {[-secure]} <nick> [file]');
    expect(line('/dcc send -secure ')).toBe('/dcc send [-passive] [-secure] {<nick>} [file]');
    const timed = usageHint('/ignore -time ', 14);
    expect(timed?.parts.filter((p) => p.active).map((p) => p.text)).toEqual(['[opts]']);
  });

  it('marks the text when its first word sits where a channel could', () => {
    expect(line('/topic Lurker')).toBe(line('/topic Lurker rocks'));
    expect(line('/topic Lurker')).toMatch(/\{\[text\]\}$/);
    expect(line('/part bye')).toMatch(/\{\[reason\]\}$/);
  });

  it('keeps a usage written by hand, unmarked', () => {
    expect(line('/mode ')).toBe('/mode [target] <flags>');
  });

  it('is absent in the system buffer for a command that needs a network', () => {
    expect(usageHint('/kick bob ', 10, [], true)).toBeNull();
    expect(usageHint('/set inp', 8, [], true)).not.toBeNull();
  });

  it('marks nothing when the line has more words than the command takes', () => {
    expect(line('/get input.foo extra ')).toBe('/get <key>');
  });

  it("is named as typed for a built-in alias, and as the command for the user's own", () => {
    expect(line('/hop ')).toMatch(/^\/hop /);
    expect(line('/j2 ', 4, [{ name: 'j2', body: '/join' }])).toMatch(/^\/join /);
  });
});
