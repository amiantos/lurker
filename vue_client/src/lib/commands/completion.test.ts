// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  completionContext,
  candidatesFor,
  argKind,
  isComplete,
  type Candidate,
  type CompletionContext,
} from './completion.js';
import { specFor } from './registry.js';

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
