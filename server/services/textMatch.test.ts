// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  buildTextTest,
  stripFormatting,
  cleanForMatch,
  rawIndexForVisibleOffset,
} from './textMatch.js';

describe('buildTextTest — substr', () => {
  it('matches case-insensitive substring by default', () => {
    const test = buildTextTest('word', 'substr', false)!;
    expect(test('a WORD here')).toBe(true);
    expect(test('keyword inside')).toBe(true); // substring, not whole-word
    expect(test('nothing')).toBe(false);
  });

  it('honors case sensitivity', () => {
    const test = buildTextTest('Word', 'substr', true)!;
    expect(test('a Word here')).toBe(true);
    expect(test('a word here')).toBe(false);
  });
});

describe('buildTextTest — plain/glob/regex parity', () => {
  it('plain is whole-word anchored', () => {
    const test = buildTextTest('user', 'plain', false)!;
    expect(test('hi user')).toBe(true);
    expect(test('username')).toBe(false);
  });

  it('glob translates wildcards with word boundaries', () => {
    const test = buildTextTest('ami*os', 'glob', false)!;
    expect(test('hey amiantos!')).toBe(true);
    expect(test('random')).toBe(false);
  });

  it('regex is raw and returns null on invalid', () => {
    expect(buildTextTest('^hi', 'regex', false)!('hi there')).toBe(true);
    expect(buildTextTest('(unclosed', 'regex', false)).toBeNull();
  });
});

describe('buildTextTest — Unicode word boundaries', () => {
  it('treats non-ASCII letters as word chars, not boundaries', () => {
    // `\W`-based matching wrongly saw `ł` as a boundary and matched `em` inside.
    const test = buildTextTest('em', 'plain', false)!;
    expect(test('zrozumiałem')).toBe(false);
    expect(test('łem')).toBe(false);
    expect(test('say em now')).toBe(true);
  });

  it('matches whole accented words and respects their boundaries', () => {
    const test = buildTextTest('café', 'plain', false)!;
    expect(test('a café here')).toBe(true);
    expect(test('cafés plural')).toBe(false);
  });

  it('matches a nick followed by punctuation but not inside a longer word', () => {
    const test = buildTextTest('brad', 'plain', false)!;
    expect(test('hey brad: hi')).toBe(true);
    expect(test('bradley spoke')).toBe(false);
  });

  it('matches a keyword that itself ends in punctuation', () => {
    const test = buildTextTest('QUACK!', 'plain', false)!;
    expect(test('QUACK!')).toBe(true);
    expect(test('the bot says QUACK! loudly')).toBe(true);
  });
});

describe('stripFormatting / cleanForMatch', () => {
  it('removes color, hex color, and every toggle code (matching the renderer)', () => {
    expect(stripFormatting('\x0304,08QUACK!\x03')).toBe('QUACK!');
    expect(stripFormatting('\x02bold\x0f \x1ditalic\x1d')).toBe('bold italic');
    expect(stripFormatting('\x04FF0000red\x04000000')).toBe('red');
    // every toggle the renderer handles: bold/mono/reverse/italic/strike/underline/reset
    expect(stripFormatting('\x02\x11\x16\x1d\x1e\x1f a \x0f')).toBe(' a ');
    // strike specifically (was missing from FORMAT_RE) — whole-word match sees through it
    expect(stripFormatting('\x1estruck\x1e')).toBe('struck');
    expect(buildTextTest('struck', 'plain', false)!(cleanForMatch('a \x1estruck\x1e word'))).toBe(
      true,
    );
  });

  it('lets whole-word matching see through formatting (the colored-QUACK bug)', () => {
    // Color code leaves a digit glued to the word, which broke the boundary.
    const test = buildTextTest('QUACK!', 'plain', false)!;
    expect(test('\x0304QUACK!\x03')).toBe(false); // raw text: boundary broken
    expect(test(cleanForMatch('\x0304QUACK!\x03'))).toBe(true); // cleaned: matches
  });

  it('treats a bare reset before digits/comma as a reset, not a color (matches the renderer)', () => {
    // \x03 + up to 2 digits IS a color code, so the digits go with it...
    expect(stripFormatting('see \x03123 done')).toBe('see 3 done');
    // ...but \x03 immediately followed by ',NN' is a bare reset; the ',NN' is
    // literal text (a bg with no fg is not a color code).
    expect(stripFormatting('a \x03,12 b')).toBe('a ,12 b');
  });

  it('cleanForMatch also strips URLs', () => {
    expect(cleanForMatch('see https://example.com/amiantos here')).not.toContain('amiantos');
  });
});

describe('rawIndexForVisibleOffset', () => {
  it('maps offsets straight through when there is no formatting', () => {
    expect(rawIndexForVisibleOffset('hello world', 6)).toBe(6);
    expect('hello world'.slice(rawIndexForVisibleOffset('hello world', 6))).toBe('world');
  });

  it('returns 0 for a non-positive offset', () => {
    expect(rawIndexForVisibleOffset('\x02abc', 0)).toBe(0);
  });

  it('skips colour codes so the raw index lands past them', () => {
    // 7 visible chars are "<FAST> " — the raw index should point at the message.
    const raw = '<\x0313FAST\x03> hi';
    expect(raw.slice(rawIndexForVisibleOffset(raw, 7))).toBe('hi');
  });

  it('clamps to the raw length when the offset exceeds the visible text', () => {
    const raw = '\x02ab\x02';
    expect(rawIndexForVisibleOffset(raw, 99)).toBe(raw.length);
  });
});
