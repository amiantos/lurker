// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import type { CompiledRule } from './highlightEngine.js';
import { compileRules, matchEvent } from './highlightEngine.js';

function rule(overrides: Partial<{
  id: number;
  pattern: string;
  kind: string;
  case_sensitive: boolean;
  enabled: boolean;
}> = {}): { id: number; pattern: string; kind: string; case_sensitive: boolean; enabled: boolean } {
  return {
    id: 1,
    pattern: 'amiantos',
    kind: 'plain',
    case_sensitive: false,
    enabled: true,
    ...overrides,
  };
}

function event(overrides: Partial<{ type: string; text: string | null | undefined; self: boolean }> = {}): { type: string; text: string | undefined; self: boolean } {
  const base: { type: string; text: string | undefined; self: boolean } = {
    type: 'message',
    text: 'hello world',
    self: false,
  };
  if ('type' in overrides) base.type = overrides.type!;
  if ('self' in overrides) base.self = overrides.self!;
  if ('text' in overrides) base.text = overrides.text ?? undefined;
  return base;
}

describe('compileRules', () => {
  it('skips disabled rules', () => {
    const compiled = compileRules([rule({ enabled: false })]);
    expect(compiled).toHaveLength(0);
  });

  it('skips rules with empty pattern', () => {
    const compiled = compileRules([rule({ pattern: '' })]);
    expect(compiled).toHaveLength(0);
  });

  it('drops invalid regex without throwing', () => {
    const compiled = compileRules([rule({ kind: 'regex', pattern: '(unclosed' })]);
    expect(compiled).toHaveLength(0);
  });

  it('compiles valid regex', () => {
    const compiled = compileRules([rule({ kind: 'regex', pattern: '^hi' })]);
    expect(compiled).toHaveLength(1);
    expect(compiled[0].test('hi there')).toBe(true);
    expect(compiled[0].test('say hi')).toBe(false);
  });
});

describe('matchEvent — plain rules', () => {
  it('matches whole-word case-insensitive by default', () => {
    const compiled = compileRules([rule({ pattern: 'amiantos' })]);
    expect(matchEvent(event({ text: 'hey amiantos' }), compiled).matched).toBe(true);
    expect(matchEvent(event({ text: 'AMIANTOS!' }), compiled).matched).toBe(true);
  });

  it('does not match substrings inside other words', () => {
    const compiled = compileRules([rule({ pattern: 'user' })]);
    expect(matchEvent(event({ text: 'username collision' }), compiled).matched).toBe(false);
    expect(matchEvent(event({ text: 'hi user' }), compiled).matched).toBe(true);
  });

  it('honors case sensitivity when set', () => {
    const compiled = compileRules([rule({ pattern: 'Amiantos', case_sensitive: true })]);
    expect(matchEvent(event({ text: 'Hi Amiantos' }), compiled).matched).toBe(true);
    expect(matchEvent(event({ text: 'hi amiantos' }), compiled).matched).toBe(false);
  });

  it('matches at start of message', () => {
    const compiled = compileRules([rule({ pattern: 'amiantos' })]);
    expect(matchEvent(event({ text: 'amiantos: hi' }), compiled).matched).toBe(true);
  });
});

describe('matchEvent — glob rules', () => {
  it('translates * to wildcard', () => {
    const compiled = compileRules([rule({ kind: 'glob', pattern: 'ami*os' })]);
    expect(matchEvent(event({ text: 'hey amiantos!' }), compiled).matched).toBe(true);
    expect(matchEvent(event({ text: 'hey amios!' }), compiled).matched).toBe(true);
    expect(matchEvent(event({ text: 'random' }), compiled).matched).toBe(false);
  });

  it('translates ? to single-char wildcard', () => {
    const compiled = compileRules([rule({ kind: 'glob', pattern: 'ami?ntos' })]);
    expect(matchEvent(event({ text: 'amiantos' }), compiled).matched).toBe(true);
    expect(matchEvent(event({ text: 'amintos' }), compiled).matched).toBe(false);
  });
});

describe('matchEvent — eligibility gating', () => {
  it('does not match self-authored events', () => {
    const compiled: CompiledRule[] = compileRules([rule()]);
    expect(matchEvent(event({ text: 'amiantos says hi', self: true }), compiled).matched).toBe(false);
  });

  it('does not match non-message types', () => {
    const compiled = compileRules([rule()]);
    expect(matchEvent(event({ type: 'notice', text: 'amiantos' }), compiled).matched).toBe(false);
    expect(matchEvent(event({ type: 'join', text: 'amiantos' }), compiled).matched).toBe(false);
    expect(matchEvent(event({ type: 'topic', text: 'amiantos' }), compiled).matched).toBe(false);
  });

  it('matches action type', () => {
    const compiled = compileRules([rule()]);
    expect(matchEvent(event({ type: 'action', text: 'waves at amiantos' }), compiled).matched).toBe(true);
  });

  it('handles missing text', () => {
    const compiled = compileRules([rule()]);
    expect(matchEvent(event({ text: null }), compiled).matched).toBe(false);
    expect(matchEvent(event({ text: '' }), compiled).matched).toBe(false);
  });

  it('returns the matched ruleId', () => {
    const compiled = compileRules([
      rule({ id: 1, pattern: 'foo' }),
      rule({ id: 2, pattern: 'bar' }),
    ]);
    expect(matchEvent(event({ text: 'hi bar' }), compiled).ruleId).toBe(2);
    expect(matchEvent(event({ text: 'hi foo' }), compiled).ruleId).toBe(1);
  });

  it('returns first match when multiple rules apply', () => {
    const compiled = compileRules([
      rule({ id: 1, pattern: 'foo' }),
      rule({ id: 2, pattern: 'bar' }),
    ]);
    expect(matchEvent(event({ text: 'foo bar' }), compiled).ruleId).toBe(1);
  });
});
