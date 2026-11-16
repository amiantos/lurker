// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  aliasTarget,
  expandAlias,
  normalizeAliasBody,
  normalizeAliasName,
  splitAliasBody,
  ALIAS_NAME_MAX,
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
