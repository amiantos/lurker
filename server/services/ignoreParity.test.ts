// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// irssi parity fixtures. irssi ships NO tests for its ignore system, so this is
// authored from its ground truth: the matching rules in src/core/ignore.c and
// every worked example in docs/help/in/ignore.in. Each example is parsed with
// our shared parser and evaluated with our matcher; deliberate divergences
// (-replies, NO_ACT, HIDDEN — not ported) are asserted, not silently dropped.

import { describe, it, expect } from 'vitest';
import type { IgnoreRuleRow } from '../db/ignoredMasks.js';
import type { IgnoreInput } from './ignoreMatch.js';
import { compileIgnoreRules, evaluateIgnores } from './ignoreMatch.js';
import { parseIgnoreArgs, type ParsedIgnore } from '../../shared/parseIgnore.js';

const NOW = Date.parse('2026-06-18T00:00:00.000Z');

function rule(parsed: ParsedIgnore): IgnoreRuleRow {
  return {
    id: 1,
    mask: parsed.mask,
    channels: parsed.channels,
    pattern: parsed.pattern,
    patternKind: parsed.patternKind,
    levels: parsed.levels,
    isExcept: parsed.isExcept,
    expiresAt: parsed.expiresAt,
    createdAt: '',
  };
}

function ev(o: Partial<IgnoreInput>): IgnoreInput {
  return {
    nick: 'bob',
    userhost: 'bob!u@h',
    target: '#irssi',
    text: '',
    type: 'message',
    isDm: false,
    ...o,
  };
}

// Parse `/ignore <args>` and evaluate one event end-to-end.
function run(args: string, event: Partial<IgnoreInput>) {
  const parsed = parseIgnoreArgs(args, NOW);
  return { parsed, verdict: evaluateIgnores(compileIgnoreRules([rule(parsed)]), ev(event), NOW) };
}

describe('irssi examples that map cleanly', () => {
  it('/IGNORE * JOINS — hides joins from anyone, not messages', () => {
    expect(run('* JOINS', { type: 'join' }).verdict.hide).toBe(true);
    expect(run('* JOINS', { type: 'message', text: 'hi' }).verdict.hide).toBe(false);
  });

  it('/IGNORE * CTCPS — CTCPS is a no-op (Lurker surfaces no CTCP type)', () => {
    const { parsed, verdict } = run('* CTCPS', { type: 'message', text: 'hi' });
    expect(parsed.levels).toEqual(['CTCPS']);
    expect(verdict.hide).toBe(false);
  });

  it('/IGNORE #irssi ALL -PUBLIC -ACTIONS — subtractive levels, channel-scoped', () => {
    expect(run('#irssi ALL -PUBLIC -ACTIONS', { type: 'message', text: 'hi' }).verdict.hide).toBe(
      false,
    ); // PUBLIC removed
    expect(run('#irssi ALL -PUBLIC -ACTIONS', { type: 'join' }).verdict.hide).toBe(true); // JOINS kept
    expect(
      run('#irssi ALL -PUBLIC -ACTIONS', { type: 'join', target: '#other' }).verdict.hide,
    ).toBe(false); // other channel
  });

  it('/IGNORE -regexp -pattern (away|gone|back|playing|returned) * ACTIONS', () => {
    const args = '-regexp -pattern (away|gone|back|playing|returned) * ACTIONS';
    expect(run(args, { type: 'action', text: 'is away now' }).verdict.hide).toBe(true);
    expect(run(args, { type: 'action', text: 'waves hello' }).verdict.hide).toBe(false);
    // ACTIONS only — a plain message containing the word is untouched.
    expect(run(args, { type: 'message', text: 'away' }).verdict.hide).toBe(false);
  });

  it('/IGNORE -regexp -pattern (...) #channel ACTIONS — channel-scoped content', () => {
    const args = '-regexp -pattern (away|gone) #channel ACTIONS';
    expect(
      run(args, { type: 'action', text: 'gone fishing', target: '#channel' }).verdict.hide,
    ).toBe(true);
    expect(run(args, { type: 'action', text: 'gone fishing', target: '#other' }).verdict.hide).toBe(
      false,
    );
  });

  it('/IGNORE *zzz* NICKS — globs the nick on a nick-change', () => {
    expect(run('*zzz* NICKS', { type: 'nick', nick: 'aFKzzz' }).verdict.hide).toBe(true);
    expect(run('*zzz* NICKS', { type: 'nick', nick: 'awake' }).verdict.hide).toBe(false);
  });

  it('/IGNORE -time 300 mike PUBLICS — active within the window', () => {
    expect(
      run('-time 300 mike PUBLICS', { type: 'message', nick: 'mike', text: 'hi' }).verdict.hide,
    ).toBe(true);
  });

  it('/IGNORE -except *!*@*.irssi.org CTCPS — parses the whitelist flag', () => {
    const { parsed } = run('-except *!*@*.irssi.org CTCPS', {});
    expect(parsed).toMatchObject({ mask: '*!*@*.irssi.org', isExcept: true, levels: ['CTCPS'] });
  });
});

describe('deliberate divergences (asserted, not silently dropped)', () => {
  it('-replies is rejected', () => {
    expect(parseIgnoreArgs('-replies *!*@*.irssi.org ALL', NOW).error).toMatch(/replies/);
  });

  it('HIDDEN is not a supported level (irssi divergence)', () => {
    expect(parseIgnoreArgs('mike HIDDEN PUBLIC JOINS PARTS QUITS', NOW).error).toMatch(
      /unexpected/,
    );
  });

  it('NO_ACT is now supported as NOUNREAD (issue #359 — parity, no longer a divergence)', () => {
    // irssi's NO_ACT ("don't trigger channel activity") maps to Lurker's
    // NOUNREAD mute modifier; it used to error as an unknown token.
    const parsed = parseIgnoreArgs('mike NO_ACT', NOW);
    expect(parsed.error).toBeUndefined();
    expect(parsed).toMatchObject({ mask: 'mike', levels: ['NOUNREAD'] });
  });
});
