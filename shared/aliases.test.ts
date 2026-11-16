// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  aliasTarget,
  expandAlias,
  normalizeAliasBody,
  normalizeAliasName,
  resolveAliases,
  splitAliasBody,
  ALIAS_NAME_MAX,
  MAX_ALIAS_COMMANDS,
} from './aliases.js';

const ctx = { channel: '#lurker', nick: 'brad', network: 'Libera' };
const expand = (body: string, args = '') => expandAlias(body, args, ctx);

describe('normalizeAliasName', () => {
  it('drops the slash and the case', () => {
    expect(normalizeAliasName('/WII')).toEqual({ ok: true, name: 'wii' });
    expect(normalizeAliasName('  pfft ')).toEqual({ ok: true, name: 'pfft' });
  });

  it('takes the name of a command that already exists', () => {
    expect(normalizeAliasName('msg')).toEqual({ ok: true, name: 'msg' });
  });

  it('refuses a name that could not be typed or removed', () => {
    for (const bad of ['', '/', 'a b', 'a/b', '-x', '.', '..', 'x'.repeat(ALIAS_NAME_MAX + 1)]) {
      expect({ name: bad, ok: normalizeAliasName(bad).ok }).toEqual({ name: bad, ok: false });
    }
  });

  it('keeps /alias and /unalias out of reach', () => {
    expect(normalizeAliasName('alias').ok).toBe(false);
    expect(normalizeAliasName('/UnAlias').ok).toBe(false);
  });
});

describe('normalizeAliasBody', () => {
  it('trims', () => {
    expect(normalizeAliasBody('  /join #a  ')).toEqual({ ok: true, body: '/join #a' });
  });

  it('refuses a body with no command in it', () => {
    expect(normalizeAliasBody('').ok).toBe(false);
    expect(normalizeAliasBody(' ; ; ').ok).toBe(false);
  });
});

describe('splitAliasBody', () => {
  it('splits on semicolons and drops the empty ones', () => {
    expect(splitAliasBody('/msg p hi; /msg f hi ;; /msg t hi;')).toEqual([
      '/msg p hi',
      '/msg f hi',
      '/msg t hi',
    ]);
  });

  it('keeps an escaped semicolon', () => {
    expect(splitAliasBody('/me winks \\;) ; /me leaves')).toEqual(['/me winks ;)', '/me leaves']);
  });

  it('leaves every other backslash alone', () => {
    expect(splitAliasBody('/me types C:\\dir')).toEqual(['/me types C:\\dir']);
  });
});

describe('expandAlias', () => {
  it('fills in numbered words', () => {
    expect(expand('/whois $1 $1', 'bob')).toEqual(['/whois bob bob']);
    expect(expand('/kick $1 $2-', 'bob being a bob')).toEqual(['/kick bob being a bob']);
    expect(expand('/x $2-3 | $3-', 'a b c d')).toEqual(['/x b c | c d']);
  });

  it('reads a dash before a letter or a variable as a dash', () => {
    expect(expand('/msg $1-bot status', 'foo bar')).toEqual(['/msg foo-bot status']);
    expect(expand('/topic $1-$2', 'a b')).toEqual(['/topic a-b']);
    expect(expand('/x $1- .', 'a b')).toEqual(['/x a b .']);
    expect(expand('/x ($2-)', 'a b c')).toEqual(['/x (b c)']);
  });

  it('leaves a word that was not typed empty', () => {
    expect(expand('/whois $1 $2', 'bob')).toEqual(['/whois bob']);
    expect(expand('/topic $2-', 'one')).toEqual(['/topic']);
  });

  it('gives $* the arguments as typed', () => {
    expect(expand('/me says  $*', ' a   b ')).toEqual(['/me says  a   b']);
  });

  it('splits numbered words on any run of spaces', () => {
    expect(expand('/x $2', 'a    b')).toEqual(['/x b']);
  });

  it('fills in where it was run', () => {
    expect(expand('/mode $channel +o $1', 'bob')).toEqual(['/mode #lurker +o bob']);
    expect(expand('/msg $chan $me on $network')).toEqual(['/msg #lurker brad on Libera']);
    expect(expand('/mode $nick +i')).toEqual(['/mode brad +i']);
  });

  it('reads a variable name whole', () => {
    expect(expand('/x $channels $chanop $nickname $men')).toEqual([
      '/x $channels $chanop $nickname $men',
    ]);
    expect(expand('/x $chan, $nick.')).toEqual(['/x #lurker, brad.']);
  });

  it('leaves a dollar that names nothing', () => {
    expect(expand('/me owes $0 and $ and $x and $$5')).toEqual(['/me owes $0 and $ and $x and $5']);
  });

  it('appends the arguments when the body names none', () => {
    expect(expand('/join', '#a key')).toEqual(['/join #a key']);
    expect(expand('/mode $nick', '+i')).toEqual(['/mode brad +i']);
  });

  it('appends to the last command only', () => {
    expect(expand('/part; /join', '#a')).toEqual(['/part', '/join #a']);
  });

  it('appends nothing once any command names a typed word', () => {
    expect(expand('/msg $1 hi; /msg bob done', 'alice extra')).toEqual([
      '/msg alice hi',
      '/msg bob done',
    ]);
  });

  it('counts a named word as used even when it was not typed', () => {
    expect(expand('/whois $1')).toEqual(['/whois']);
  });

  it('adds the slash a command left off', () => {
    expect(expand('join #a; /part #b')).toEqual(['/join #a', '/part #b']);
  });

  it('does not expand what was typed', () => {
    expect(expand('/msg $1 $2-', 'bob $1 $channel; /quit')).toEqual([
      '/msg bob $1 $channel; /quit',
    ]);
  });

  it('runs the commands of the issue', () => {
    expect(expand('/msg p hi; /msg f hi; /msg f hi; /msg t hi')).toEqual([
      '/msg p hi',
      '/msg f hi',
      '/msg f hi',
      '/msg t hi',
    ]);
  });
});

describe('aliasTarget', () => {
  it('names the command a plain rename stands for', () => {
    expect(aliasTarget('/join')).toEqual({ verb: 'join', words: [] });
    expect(aliasTarget('DCC  chat')).toEqual({ verb: 'dcc', words: ['chat'] });
  });

  it('is null when a typed word has no one slot', () => {
    expect(aliasTarget('/whois $1 $1')).toBeNull();
    expect(aliasTarget('/part; /join')).toBeNull();
  });
});

describe('resolveAliases, fanned out', () => {
  const twenty = (next: string) => Array.from({ length: 20 }, () => next).join(';');

  it('runs nothing once a line comes to too many commands', () => {
    // 20^6 commands, six deep: under the depth limit, far over any sane count.
    const chain = Array.from({ length: 6 }, (_, i) => ({
      name: `f${i}`,
      body: i === 5 ? '/quote END' : twenty(`/f${i + 1}`),
    }));
    chain[4].body = twenty('/f5');
    const out = resolveAliases('/f0', chain, ctx);
    expect(out).toEqual({ lines: [], stoppedAt: null, tooMany: true });
  });

  it('runs a line that comes to exactly the limit', () => {
    const body = Array.from({ length: MAX_ALIAS_COMMANDS }, () => '/quote X').join(';');
    const out = resolveAliases('/big', [{ name: 'big', body }], ctx);
    expect(out.lines).toHaveLength(MAX_ALIAS_COMMANDS);
    expect(out.tooMany).toBe(false);
    const over = resolveAliases('/big', [{ name: 'big', body: `${body};/quote X` }], ctx);
    expect(over).toEqual({ lines: [], stoppedAt: null, tooMany: true });
  });
});

describe('resolveAliases', () => {
  const resolve = (line: string, aliases: { name: string; body: string }[]) =>
    resolveAliases(line, aliases, ctx);

  it('returns a line that names no alias as it is', () => {
    expect(resolve('/join  #a', [{ name: 'j2', body: '/join' }])).toEqual({
      lines: ['/join  #a'],
      stoppedAt: null,
      tooMany: false,
    });
  });

  it('expands aliases inside aliases, in order', () => {
    const aliases = [
      { name: 'outer', body: '/inner $1; /quote LAST' },
      { name: 'inner', body: '/quote A $1; /quote B' },
    ];
    expect(resolve('/OUTER x', aliases).lines).toEqual(['/quote A x', '/quote B', '/quote LAST']);
  });

  it('leaves a name that is already running alone', () => {
    expect(resolve('/quit', [{ name: 'quit', body: '/quit gone fishing' }]).lines).toEqual([
      '/quit gone fishing',
    ]);
    const loop = [
      { name: 'a', body: '/b' },
      { name: 'b', body: '/a again' },
    ];
    expect(resolve('/a', loop).lines).toEqual(['/a again']);
  });

  it('never runs a reserved name as an alias', () => {
    expect(resolve('/alias -x', [{ name: 'alias', body: '/quit' }]).lines).toEqual(['/alias -x']);
  });

  it('stops a chain that is too deep, and names where', () => {
    const chain = Array.from({ length: 12 }, (_, i) => ({ name: `a${i}`, body: `/a${i + 1}` }));
    expect(resolve('/a0', chain)).toEqual({ lines: [], stoppedAt: 'a10', tooMany: false });
    expect(resolve('/a2', chain).lines).toEqual(['/a12']);
  });
});
