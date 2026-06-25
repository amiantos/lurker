// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  splitSay,
  splitAction,
  splitMultiline,
  partitionMultiline,
  reassembleMultiline,
  hasInteriorNewline,
} from './messageSplit.js';

const MESSAGE_MAX_BYTES = 350;
const ACTION_MAX_BYTES = 341;

function byteLen(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

describe('splitSay', () => {
  it('returns one chunk for short ASCII input', () => {
    expect(splitSay('hello world')).toEqual(['hello world']);
  });

  it('returns [] for empty / null input', () => {
    expect(splitSay('')).toEqual([]);
    expect(splitSay(null)).toEqual([]);
    expect(splitSay(undefined)).toEqual([]);
  });

  it('keeps a single chunk for input right at the byte limit', () => {
    const text = 'a'.repeat(MESSAGE_MAX_BYTES);
    const chunks = splitSay(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits a string that exceeds the byte limit, with every chunk ≤ limit', () => {
    // Long ASCII word — forces grapheme-level breaks. Picking just over 2x
    // so we know we get at least 3 chunks.
    const text = 'a'.repeat(MESSAGE_MAX_BYTES * 2 + 50);
    const chunks = splitSay(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(byteLen(c)).toBeLessThanOrEqual(MESSAGE_MAX_BYTES);
    }
    // No content loss — concatenating reconstructs the original.
    expect(chunks.join('')).toBe(text);
  });

  it('breaks at word boundaries when possible', () => {
    // Build a stream of short words that adds up past the limit. We should
    // get a break at a space boundary, not mid-word.
    const word = 'foo ';
    const text = word.repeat(Math.ceil((MESSAGE_MAX_BYTES * 1.5) / word.length));
    const chunks = splitSay(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Each chunk should consist of whole 'foo' tokens (and spaces) — never
      // a fragment like 'fo' or 'o'.
      expect(
        c
          .replace(/\s+/g, ' ')
          .trim()
          .split(' ')
          .every((w) => w === 'foo'),
      ).toBe(true);
    }
  });

  it('produces one chunk per line for multi-line input under the limit', () => {
    expect(splitSay('one\ntwo\nthree')).toEqual(['one', 'two', 'three']);
    expect(splitSay('one\r\ntwo\rthree')).toEqual(['one', 'two', 'three']);
  });

  it('drops empty lines between newlines (irc-framework behavior)', () => {
    // \n\n collapses to one separator with no empty chunk between them.
    expect(splitSay('one\n\ntwo')).toEqual(['one', 'two']);
  });

  it('respects byte length, not character length, for multi-byte UTF-8', () => {
    // '🔥' is 4 UTF-8 bytes per emoji. 100 of them = 400 bytes, over the 350
    // byte limit, so the result must split.
    const text = '🔥'.repeat(100);
    const chunks = splitSay(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(byteLen(c)).toBeLessThanOrEqual(MESSAGE_MAX_BYTES);
    }
    expect(chunks.join('')).toBe(text);
  });
});

describe('splitAction', () => {
  it('returns one chunk for short input', () => {
    expect(splitAction('waves')).toEqual(['waves']);
  });

  it('uses the tighter ACTION byte budget', () => {
    // A line that fits in PRIVMSG (350) but not in ACTION (341) should split.
    const text = 'a'.repeat(345);
    expect(splitSay(text)).toHaveLength(1);
    const actionChunks = splitAction(text);
    expect(actionChunks.length).toBeGreaterThan(1);
    for (const c of actionChunks) {
      expect(byteLen(c)).toBeLessThanOrEqual(ACTION_MAX_BYTES);
    }
  });

  it('does not pre-split on newlines (matches irc-framework)', () => {
    // irc-framework's client.action() doesn't split on \n the way sendMessage
    // does — newlines stay embedded in the CTCP body. We mirror that so the
    // self-message events match what was actually transmitted.
    const chunks = splitAction('one\ntwo');
    expect(chunks).toEqual(['one\ntwo']);
  });

  it('returns [] for empty input', () => {
    expect(splitAction('')).toEqual([]);
    expect(splitAction(null)).toEqual([]);
  });
});

describe('splitMultiline', () => {
  it('returns [] for empty / null input', () => {
    expect(splitMultiline('')).toEqual([]);
    expect(splitMultiline(null)).toEqual([]);
    expect(splitMultiline(undefined)).toEqual([]);
  });

  it('emits one non-concat message per line', () => {
    expect(splitMultiline('one\ntwo\nthree')).toEqual([
      { content: 'one', concat: false },
      { content: 'two', concat: false },
      { content: 'three', concat: false },
    ]);
    expect(splitMultiline('one\r\ntwo\rthree')).toEqual([
      { content: 'one', concat: false },
      { content: 'two', concat: false },
      { content: 'three', concat: false },
    ]);
  });

  it('PRESERVES interior blank lines (unlike splitSay, which drops them)', () => {
    // A blank line round-trips as an empty PRIVMSG, so a pasted paragraph break
    // survives. splitSay('a\n\nb') would be ['a','b']; multiline keeps the gap.
    expect(splitMultiline('a\n\nb')).toEqual([
      { content: 'a', concat: false },
      { content: '', concat: false },
      { content: 'b', concat: false },
    ]);
  });

  it('trims leading/trailing blank lines (no spurious edge messages)', () => {
    // 'hello\n' must not send a trailing empty PRIVMSG the legacy path would
    // drop. Interior blanks still survive; pure-blank input is empty.
    expect(splitMultiline('hello\n')).toEqual([{ content: 'hello', concat: false }]);
    expect(splitMultiline('\na\n\nb\n')).toEqual([
      { content: 'a', concat: false },
      { content: '', concat: false },
      { content: 'b', concat: false },
    ]);
    expect(splitMultiline('\n\n')).toEqual([]);
  });

  it('byte-splits an over-long line and marks the continuations concat', () => {
    // One logical line over the per-message budget: the 2nd+ chunks carry
    // concat so the receiver rejoins them without inserting a newline.
    const long = 'a'.repeat(MESSAGE_MAX_BYTES * 2 + 50);
    const parts = splitMultiline(long);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[0].concat).toBe(false);
    expect(parts.slice(1).every((p) => p.concat)).toBe(true);
    for (const p of parts) {
      expect(byteLen(p.content)).toBeLessThanOrEqual(MESSAGE_MAX_BYTES);
    }
    // Joining the content back (concat = no separator) reconstructs the line.
    expect(parts.map((p) => p.content).join('')).toBe(long);
  });

  it('only the first chunk of each line is non-concat', () => {
    // Two over-long lines: each line restarts with a non-concat head, then
    // concat continuations — so reassembly inserts exactly one newline between.
    const a = 'a'.repeat(MESSAGE_MAX_BYTES + 10);
    const b = 'b'.repeat(MESSAGE_MAX_BYTES + 10);
    const parts = splitMultiline(`${a}\n${b}`);
    const heads = parts.filter((p) => !p.concat);
    expect(heads).toHaveLength(2);
    expect(heads[0].content.startsWith('a')).toBe(true);
    expect(heads[1].content.startsWith('b')).toBe(true);
  });
});

describe('partitionMultiline', () => {
  const big = { maxBytes: 4096, maxLines: 24 };

  it('returns [] for empty input', () => {
    expect(partitionMultiline('', big)).toEqual([]);
    expect(partitionMultiline(null, big)).toEqual([]);
  });

  it('keeps a body within the limits as a single batch', () => {
    expect(partitionMultiline('one\ntwo\nthree', big)).toEqual([
      [
        { content: 'one', concat: false },
        { content: 'two', concat: false },
        { content: 'three', concat: false },
      ],
    ]);
  });

  it('splits into multiple batches past the line budget', () => {
    const batches = partitionMultiline('a\nb\nc\nd\ne', { maxBytes: 4096, maxLines: 2 });
    expect(batches.map((b) => b.map((w) => w.content))).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('splits into multiple batches past the byte budget', () => {
    // Three ~60-byte lines, max-bytes 100 → one line per batch.
    const body = `${'a'.repeat(60)}\n${'b'.repeat(60)}\n${'c'.repeat(60)}`;
    const batches = partitionMultiline(body, { maxBytes: 100, maxLines: 24 });
    expect(batches).toHaveLength(3);
  });

  it('keeps a byte-split (concat) logical line whole when it fits a batch', () => {
    // 'a'*400 → [350 + 50(concat)] = 2 wire messages, 400 bytes — well within
    // the budget, so it stays in one batch alongside the next line.
    const batches = partitionMultiline(`${'a'.repeat(400)}\nb`, big);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      { content: 'a'.repeat(350), concat: false },
      { content: 'a'.repeat(50), concat: true },
      { content: 'b', concat: false },
    ]);
  });

  it('tears a single line that is bigger than a whole batch (no overflow, no data loss)', () => {
    // max-lines 1 can't hold the 2-wire line whole, so it must split across
    // batches rather than emit one over-budget batch the server would reject.
    const byLines = partitionMultiline(`${'a'.repeat(400)}\nb`, { maxBytes: 4096, maxLines: 1 });
    expect(byLines.map((b) => b.map((w) => w.content))).toEqual([
      ['a'.repeat(350)],
      ['a'.repeat(50)],
      ['b'],
    ]);

    // Same when the byte budget is the binding constraint.
    const byBytes = partitionMultiline('a'.repeat(400), { maxBytes: 380, maxLines: 24 });
    expect(byBytes.map((b) => b.map((w) => w.content))).toEqual([
      ['a'.repeat(350)],
      ['a'.repeat(50)],
    ]);
    // Every batch is within budget — the whole point.
    for (const batch of byBytes) {
      const bytes = batch.reduce((n, w) => n + new TextEncoder().encode(w.content).byteLength, 0);
      expect(bytes).toBeLessThanOrEqual(380);
    }
  });

  it('re-chunks wire content so no batch overflows even when max-bytes < 350', () => {
    // Pathological server (max-bytes 100 < a full wire line): a single wire
    // message is normally ≤350B, so it would overflow a 100B batch — partition
    // must re-chunk it smaller. (Production gates this to legacy via
    // multilineLimits, but the partition must never emit an over-budget batch.)
    const batches = partitionMultiline('a'.repeat(900), { maxBytes: 100, maxLines: 24 });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const bytes = batch.reduce((n, w) => n + new TextEncoder().encode(w.content).byteLength, 0);
      expect(bytes).toBeLessThanOrEqual(100);
    }
    // No content lost — joining every wire reconstructs the original line.
    expect(
      batches
        .flat()
        .map((w) => w.content)
        .join(''),
    ).toBe('a'.repeat(900));
  });
});

describe('reassembleMultiline', () => {
  it('joins with newlines except across concat continuations', () => {
    expect(
      reassembleMultiline([
        { content: 'line one', concat: false },
        { content: 'line two', concat: false },
      ]),
    ).toBe('line one\nline two');
    expect(
      reassembleMultiline([
        { content: 'hello ', concat: false },
        { content: 'world', concat: true },
      ]),
    ).toBe('hello world');
  });

  it('round-trips a partitioned batch back to its source text', () => {
    const [batch] = partitionMultiline('a\n\nb', { maxBytes: 4096, maxLines: 24 });
    expect(reassembleMultiline(batch)).toBe('a\n\nb');
  });
});

describe('hasInteriorNewline', () => {
  it('is false for single-line input or edge-only newlines', () => {
    expect(hasInteriorNewline('hello')).toBe(false);
    expect(hasInteriorNewline('hello\n')).toBe(false); // trailing edge
    expect(hasInteriorNewline('\nhello')).toBe(false); // leading edge
    expect(hasInteriorNewline('\n\nhello\n\n')).toBe(false);
    expect(hasInteriorNewline('')).toBe(false);
  });

  it('is true when a newline sits between content (a real multi-line body)', () => {
    expect(hasInteriorNewline('a\nb')).toBe(true);
    expect(hasInteriorNewline('a\n\nb')).toBe(true); // interior blank counts
    expect(hasInteriorNewline('hello\nworld\n')).toBe(true); // edges trimmed, interior remains
  });
});
