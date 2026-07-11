// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first — fserveConfig → dccConfig/settingsService → db/index opens the
// real DB at module load unless DATABASE_PATH is redirected before then.
import '../test-utils/isolateDb.js';
import { describe, it, expect } from 'vitest';
import {
  maskToRegExp,
  allowlistMatches,
  decideFserveAccess,
  type FserveAccessMode,
} from './fserveConfig.js';

describe('maskToRegExp', () => {
  it('matches * and ? wildcards, case-insensitively, anchored', () => {
    expect(maskToRegExp('*!*@*').test('alice!u@host')).toBe(true);
    expect(maskToRegExp('alice!*@*').test('ALICE!x@y')).toBe(true);
    expect(maskToRegExp('alice!*@*').test('bob!x@y')).toBe(false);
    expect(maskToRegExp('a?ice!*@*').test('alice!x@y')).toBe(true);
    expect(maskToRegExp('*@*.trusted.net').test('n!u@box.trusted.net')).toBe(true);
    expect(maskToRegExp('*@*.trusted.net').test('n!u@box.evil.net')).toBe(false);
  });

  it('escapes regex metacharacters in the literal parts', () => {
    // The dot is literal, not "any char".
    expect(maskToRegExp('a.b!*@*').test('axb!u@h')).toBe(false);
    expect(maskToRegExp('a.b!*@*').test('a.b!u@h')).toBe(true);
  });
});

describe('allowlistMatches', () => {
  const hm = 'alice!user@box.example.com';
  it('matches a full hostmask glob', () => {
    expect(allowlistMatches(['alice!*@*'], hm, 'alice')).toBe(true);
    expect(allowlistMatches(['*!*@*.example.com'], hm, 'alice')).toBe(true);
    expect(allowlistMatches(['bob!*@*'], hm, 'alice')).toBe(false);
  });
  it('treats a bare-nick entry as that nick from any host', () => {
    expect(allowlistMatches(['alice'], hm, 'alice')).toBe(true);
    expect(allowlistMatches(['Alice'], hm, 'alice')).toBe(true); // case-insensitive
    expect(allowlistMatches(['carol'], hm, 'alice')).toBe(false);
  });
  it('empty allowlist matches nothing', () => {
    expect(allowlistMatches([], hm, 'alice')).toBe(false);
  });
});

describe('decideFserveAccess', () => {
  const hm = 'alice!user@box.example.com';
  it('open always allows', () => {
    expect(decideFserveAccess('open', [], hm, 'alice')).toEqual({ kind: 'allow' });
  });
  it('password defers to the in-session prompt', () => {
    expect(decideFserveAccess('password', [], hm, 'alice')).toEqual({ kind: 'password' });
  });
  it('allowlist allows a match and denies a miss', () => {
    expect(decideFserveAccess('allowlist', ['alice'], hm, 'alice')).toEqual({ kind: 'allow' });
    const denied = decideFserveAccess('allowlist', ['bob'], hm, 'alice');
    expect(denied.kind).toBe('deny');
  });
  it('narrows unknown modes to open (never accidentally locks/opens wrong)', () => {
    // Types guard this, but a stray stored value should still be safe.
    const mode = 'weird' as unknown as FserveAccessMode;
    expect(decideFserveAccess(mode, [], hm, 'alice')).toEqual({ kind: 'allow' });
  });
});
