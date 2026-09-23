// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  batchModeLines,
  DEFAULT_PREFIX,
  hasRankAtLeast,
  modeTakesParam,
  parseModeSpec,
  rankIndex,
  sortByRank,
  type PrefixMode,
} from './channelModes.js';

// Libera (solanum) as irc-framework leaves it after 005: `q` is a quiet LIST
// mode, and PREFIX has only ops and voices.
const SOLANUM_OPTIONS = {
  CHANMODES: ['eIbq', 'k', 'flj', 'CFLMPQRSTcgimnprstuz'],
  PREFIX: [
    { symbol: '@', mode: 'o' },
    { symbol: '+', mode: 'v' },
  ],
  MODES: '4',
  TOPICLEN: '390',
};

const OV: PrefixMode[] = [
  { mode: 'o', symbol: '@' },
  { mode: 'v', symbol: '+' },
];
const QAOHV = DEFAULT_PREFIX as PrefixMode[];

describe('parseModeSpec', () => {
  it('falls back to the RFC defaults before 005 has said anything', () => {
    expect(parseModeSpec({})).toEqual({
      list: 'beI',
      always: 'k',
      onSet: 'l',
      flags: 'imnst',
      prefix: QAOHV,
      maxModes: 3,
      topicLen: null,
    });
    expect(parseModeSpec(undefined).list).toBe('beI');
  });

  it("reads solanum's groups, keeping q as a list mode", () => {
    const spec = parseModeSpec(SOLANUM_OPTIONS);
    expect(spec.list).toBe('eIbq');
    expect(spec.always).toBe('k');
    expect(spec.onSet).toBe('flj');
    expect(spec.prefix.map((p) => p.mode)).toEqual(['o', 'v']);
    expect(spec.maxModes).toBe(4);
    expect(spec.topicLen).toBe(390);
  });

  it('treats a letter listed in both PREFIX and CHANMODES as a prefix', () => {
    // weechat irc-mode.c:110-116 / irssi irc-servers.c:1159 — some ircds list
    // prefix letters in group A.
    const spec = parseModeSpec({ CHANMODES: ['beIqa', 'k', 'l', 'imnst'], PREFIX: QAOHV });
    expect(spec.list).toBe('beI');
  });

  it('never puts one letter in two groups', () => {
    const spec = parseModeSpec({ CHANMODES: ['b', 'kb', 'lk', 'nl'], PREFIX: OV });
    expect([spec.list, spec.always, spec.onSet, spec.flags]).toEqual(['b', 'k', 'l', 'n']);
  });

  it('reads a bare MODES token as "no limit" and a nonsense one as the default', () => {
    expect(parseModeSpec({ MODES: true }).maxModes).toBeNull();
    expect(parseModeSpec({ MODES: '0' }).maxModes).toBe(3);
    expect(parseModeSpec({ MODES: 'lots' }).maxModes).toBe(3);
  });

  it('honours an empty PREFIX, and falls back when PREFIX was malformed', () => {
    expect(parseModeSpec({ PREFIX: [] }).prefix).toEqual([]);
    // irc-framework leaves the raw string in place when it can't parse it.
    expect(parseModeSpec({ PREFIX: 'ov@+' }).prefix).toEqual(QAOHV);
  });

  it('keeps missing trailing groups empty rather than defaulting them', () => {
    const spec = parseModeSpec({ CHANMODES: ['b', 'k'], PREFIX: OV });
    expect(spec.onSet).toBe('');
    expect(spec.flags).toBe('');
  });

  it('ignores a TOPICLEN that is not a positive integer', () => {
    expect(parseModeSpec({ TOPICLEN: true }).topicLen).toBeNull();
    expect(parseModeSpec({ TOPICLEN: '-5' }).topicLen).toBeNull();
  });
});

describe('modeTakesParam', () => {
  const spec = parseModeSpec(SOLANUM_OPTIONS);

  it('follows the CHANMODES groups', () => {
    expect(modeTakesParam(spec, 'b', '+')).toBe(true);
    expect(modeTakesParam(spec, 'b', '-')).toBe(true);
    expect(modeTakesParam(spec, 'k', '-')).toBe(true);
    expect(modeTakesParam(spec, 'l', '+')).toBe(true);
    expect(modeTakesParam(spec, 'l', '-')).toBe(false);
    expect(modeTakesParam(spec, 'n', '+')).toBe(false);
  });

  it('gives prefix letters a param both ways and unknown letters none', () => {
    expect(modeTakesParam(spec, 'o', '-')).toBe(true);
    expect(modeTakesParam(spec, 'X', '+')).toBe(false);
  });
});

describe('rank', () => {
  it('finds the highest mode by PREFIX order, not array position', () => {
    // A member voiced first and opped second holds ['v', 'o'].
    expect(rankIndex(['v', 'o'], QAOHV)).toBe(2);
    expect(rankIndex([], QAOHV)).toBe(-1);
    expect(rankIndex(null, QAOHV)).toBe(-1);
  });

  it('sorts into rank order and keeps letters PREFIX lacks at the end', () => {
    expect(sortByRank(['v', 'X', 'o', 'q'], QAOHV)).toEqual(['q', 'o', 'v', 'X']);
  });

  it('ranks by a nonstandard PREFIX', () => {
    // ZNC's StatusModes case: PREFIX=(Yohv)!@%+
    const prefix: PrefixMode[] = [
      { mode: 'Y', symbol: '!' },
      { mode: 'o', symbol: '@' },
      { mode: 'h', symbol: '%' },
      { mode: 'v', symbol: '+' },
    ];
    expect(hasRankAtLeast(['Y'], prefix, 'o')).toBe(true);
    expect(hasRankAtLeast(['h'], prefix, 'o')).toBe(false);
  });

  it('lets an owner or admin through an op gate', () => {
    expect(hasRankAtLeast(['q'], QAOHV, 'o')).toBe(true);
    expect(hasRankAtLeast(['a'], QAOHV, 'o')).toBe(true);
    expect(hasRankAtLeast(['h'], QAOHV, 'o')).toBe(false);
    expect(hasRankAtLeast(['h', 'v'], QAOHV, 'h')).toBe(true);
    expect(hasRankAtLeast([], QAOHV, 'v')).toBe(false);
  });

  it('rounds a gate on a letter the network lacks UP to one it has', () => {
    // No halfops on solanum: a halfop gate means op or higher.
    expect(hasRankAtLeast(['o'], OV, 'h')).toBe(true);
    expect(hasRankAtLeast(['v'], OV, 'h')).toBe(false);
    // No owner or admin above it either: nothing can pass.
    expect(hasRankAtLeast(['o'], OV, 'q')).toBe(false);
  });
});

describe('batchModeLines', () => {
  const ops = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ sign: '+' as const, letter: 'o', param: n }));

  it('splits param-taking changes at MODES', () => {
    expect(batchModeLines('#c', ops, 3)).toEqual(['MODE #c +ooo a b c', 'MODE #c +oo d e']);
  });

  it('sends one line when the server sets no limit', () => {
    expect(batchModeLines('#c', ops, null)).toEqual(['MODE #c +ooooo a b c d e']);
  });

  it('counts only the changes that carry a param', () => {
    const changes = [
      { sign: '+' as const, letter: 'n' },
      { sign: '+' as const, letter: 't' },
      { sign: '+' as const, letter: 'l', param: '10' },
      { sign: '+' as const, letter: 'k', param: 'key' },
    ];
    expect(batchModeLines('#c', changes, 2)).toEqual(['MODE #c +ntlk 10 key']);
    expect(batchModeLines('#c', changes, 1)).toEqual(['MODE #c +ntl 10', 'MODE #c +k key']);
  });

  it('keeps params in letter order across sign changes, restating the sign per line', () => {
    const changes = [
      { sign: '-' as const, letter: 'o', param: 'alice' },
      { sign: '+' as const, letter: 'v', param: 'alice' },
      { sign: '-' as const, letter: 'l' },
      { sign: '+' as const, letter: 'b', param: '*!*@bad' },
    ];
    expect(batchModeLines('#c', changes, 2)).toEqual([
      'MODE #c -o+v-l alice alice',
      'MODE #c +b *!*@bad',
    ]);
  });

  it('splits on line length even under the MODES limit', () => {
    const mask = 'x'.repeat(150);
    const bans = [1, 2, 3].map((i) => ({ sign: '+' as const, letter: 'b', param: `${mask}${i}` }));
    const lines = batchModeLines('#c', bans, null);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`MODE #c +bb ${mask}1 ${mask}2`);
    expect(lines[1]).toBe(`MODE #c +b ${mask}3`);
  });

  it('sends nothing for nothing', () => {
    expect(batchModeLines('#c', [], 3)).toEqual([]);
  });
});
