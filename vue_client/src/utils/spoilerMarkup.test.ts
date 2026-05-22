// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { applySpoilerMarkup } from './spoilerMarkup.js';

// A spoiler on the wire is colour code 01 (black) on background 01.
const OPEN = '\x0301,01';
const CLOSE = '\x03';

describe('applySpoilerMarkup', () => {
  it('leaves text with no double-pipes untouched', () => {
    expect(applySpoilerMarkup('hello world')).toBe('hello world');
    expect(applySpoilerMarkup('')).toBe('');
    expect(applySpoilerMarkup('a | b')).toBe('a | b');
  });

  it('rewrites a basic ||spoiler|| into IRC spoiler codes', () => {
    expect(applySpoilerMarkup('||secret||')).toBe(`${OPEN}secret${CLOSE}`);
  });

  it('preserves the text around a spoiler', () => {
    expect(applySpoilerMarkup('the answer is ||42|| ok?')).toBe(
      `the answer is ${OPEN}42${CLOSE} ok?`,
    );
  });

  it('rewrites multiple spoilers in one message', () => {
    expect(applySpoilerMarkup('||a|| and ||b||')).toBe(`${OPEN}a${CLOSE} and ${OPEN}b${CLOSE}`);
  });

  it('pairs non-greedily — the nearest closing || wins', () => {
    // ||a||b||c|| -> spoiler(a), literal b, spoiler(c)
    expect(applySpoilerMarkup('||a||b||c||')).toBe(`${OPEN}a${CLOSE}b${OPEN}c${CLOSE}`);
  });

  it('leaves an unmatched || literal', () => {
    expect(applySpoilerMarkup('||unclosed')).toBe('||unclosed');
    expect(applySpoilerMarkup('trailing||')).toBe('trailing||');
  });

  it('leaves an empty |||| literal', () => {
    expect(applySpoilerMarkup('||||')).toBe('||||');
  });

  it('treats \\|| as an escape, emitting a literal || and no spoiler', () => {
    expect(applySpoilerMarkup('exit code \\|| 1')).toBe('exit code || 1');
    expect(applySpoilerMarkup('\\||not a spoiler\\||')).toBe('||not a spoiler||');
  });

  it('allows an escaped || inside a real spoiler', () => {
    expect(applySpoilerMarkup('||has \\|| inside||')).toBe(`${OPEN}has || inside${CLOSE}`);
  });

  it('leaves a lone backslash literal', () => {
    expect(applySpoilerMarkup('a \\ b')).toBe('a \\ b');
    expect(applySpoilerMarkup('path\\to\\file')).toBe('path\\to\\file');
  });
});
