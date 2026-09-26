// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { replyExcerpt, stripReplyAddress } from './replyText.js';

describe('stripReplyAddress', () => {
  it('drops the address to the author being answered', () => {
    expect(stripReplyAddress('alice: sure', 'alice')).toBe('sure');
    expect(stripReplyAddress('alice, sure', 'alice')).toBe('sure');
    expect(stripReplyAddress('Alice:  sure', 'alice')).toBe('sure');
  });

  it('keeps a first word that only looks like the nick', () => {
    // A reply to `will` that opens with the word "will".
    expect(stripReplyAddress('will you come?', 'will')).toBe('will you come?');
    // A different nick that starts with this one.
    expect(stripReplyAddress('alicia: hi', 'alice')).toBe('alicia: hi');
    // `bob_` is its own nick (every ghost's), not bob plus punctuation.
    expect(stripReplyAddress('bob_: hi', 'bob')).toBe('bob_: hi');
  });

  it('keeps an address to someone else', () => {
    expect(stripReplyAddress('carol: ask alice', 'alice')).toBe('carol: ask alice');
  });

  it('treats the nick literally, not as a pattern', () => {
    expect(stripReplyAddress('[m]x: hi', '[m]x')).toBe('hi');
    expect(stripReplyAddress('mx: hi', '[m]x')).toBe('mx: hi');
  });

  it('never strips a line to nothing', () => {
    expect(stripReplyAddress('alice: ', 'alice')).toBe('alice: ');
  });
});

describe('replyExcerpt', () => {
  it('drops formatting and folds lines into one', () => {
    expect(replyExcerpt('\x02bold\x02 and \x0304red\x03\nsecond line')).toBe(
      'bold and red second line',
    );
  });
});
