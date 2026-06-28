// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  createNavHistory,
  recordVisit,
  stepIndex,
  MAX_HISTORY,
  type NavHistory,
} from './navHistory.js';

// Build a history and replay a sequence of visits through recordVisit, the way
// the activeKey watcher feeds it live.
function visiting(...keys: string[]): NavHistory {
  const h = createNavHistory();
  for (const k of keys) recordVisit(h, k);
  return h;
}

describe('recordVisit', () => {
  it('pushes the first visit and parks the cursor on it', () => {
    const h = visiting('1::#a');
    expect(h.stack).toEqual(['1::#a']);
    expect(h.index).toBe(0);
  });

  it('appends distinct visits and tracks the cursor at the tail', () => {
    const h = visiting('1::#a', '1::#b', '1::#c');
    expect(h.stack).toEqual(['1::#a', '1::#b', '1::#c']);
    expect(h.index).toBe(2);
  });

  it('collapses re-entering the buffer already at the cursor', () => {
    const h = visiting('1::#a', '1::#a');
    expect(h.stack).toEqual(['1::#a']);
    expect(h.index).toBe(0);
    expect(recordVisit(h, '1::#a')).toBe(false);
  });

  it('keeps non-consecutive repeats (A, B, A is a real path)', () => {
    const h = visiting('1::#a', '1::#b', '1::#a');
    expect(h.stack).toEqual(['1::#a', '1::#b', '1::#a']);
    expect(h.index).toBe(2);
  });

  it('truncates the forward branch when navigating somewhere new after going back', () => {
    const h = visiting('1::#a', '1::#b', '1::#c');
    h.index = 0; // pretend the user pressed back twice to land on #a
    recordVisit(h, '1::#z');
    expect(h.stack).toEqual(['1::#a', '1::#z']);
    expect(h.index).toBe(1);
  });

  it('is a no-op when re-recording the cursor entry mid-history (back then click-same)', () => {
    const h = visiting('1::#a', '1::#b', '1::#c');
    h.index = 1;
    expect(recordVisit(h, '1::#b')).toBe(false);
    expect(h.stack).toEqual(['1::#a', '1::#b', '1::#c']);
    expect(h.index).toBe(1);
  });

  it('evicts the oldest entries past the cap and shifts the cursor with them', () => {
    const h = createNavHistory();
    for (let i = 0; i < MAX_HISTORY + 5; i++) recordVisit(h, `1::#c${i}`);
    expect(h.stack.length).toBe(MAX_HISTORY);
    expect(h.stack[0]).toBe('1::#c5'); // first five dropped
    expect(h.stack[h.stack.length - 1]).toBe(`1::#c${MAX_HISTORY + 4}`);
    expect(h.index).toBe(MAX_HISTORY - 1);
  });
});

describe('stepIndex', () => {
  const allLive = () => true;

  it('walks back and forward one live entry at a time', () => {
    const h = visiting('1::#a', '1::#b', '1::#c'); // index 2
    expect(stepIndex(h, -1, allLive)).toBe(1);
    h.index = 1;
    expect(stepIndex(h, -1, allLive)).toBe(0);
    expect(stepIndex(h, 1, allLive)).toBe(2);
  });

  it('returns -1 at the back and forward boundaries', () => {
    const h = visiting('1::#a', '1::#b'); // index 1 (tail)
    expect(stepIndex(h, 1, allLive)).toBe(-1); // already at the front
    h.index = 0;
    expect(stepIndex(h, -1, allLive)).toBe(-1); // already at the back
  });

  it('returns -1 for an empty history', () => {
    expect(stepIndex(createNavHistory(), -1, allLive)).toBe(-1);
  });

  it('skips dead entries and lands on the nearest live one', () => {
    const h = visiting('1::#a', '1::#dead', '1::#c'); // index 2
    const exists = (k: string) => k !== '1::#dead';
    expect(stepIndex(h, -1, exists)).toBe(0); // hop over #dead
  });

  it('returns -1 when every entry in the requested direction is dead', () => {
    const h = visiting('1::#x', '1::#y', '1::#z'); // index 2
    const exists = (k: string) => k === '1::#z'; // only the current is live
    expect(stepIndex(h, -1, exists)).toBe(-1);
  });
});
