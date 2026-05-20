// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { splitSay, splitAction } from './messageSplit.js';

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
    const text = word.repeat(Math.ceil(MESSAGE_MAX_BYTES * 1.5 / word.length));
    const chunks = splitSay(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Each chunk should consist of whole 'foo' tokens (and spaces) — never
      // a fragment like 'fo' or 'o'.
      expect(c.replace(/\s+/g, ' ').trim().split(' ').every((w) => w === 'foo')).toBe(true);
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
