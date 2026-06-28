// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  createRecentBuffers,
  recordRecent,
  recencyRank,
  MAX_RECENT,
  type RecentBuffers,
} from './recentBuffers.js';

// Replay a sequence of visits through recordRecent, the way the activeKey
// watcher feeds it live (left-to-right = oldest-to-newest).
function visiting(...keys: string[]): RecentBuffers {
  const r = createRecentBuffers();
  for (const k of keys) recordRecent(r, k);
  return r;
}

describe('recordRecent', () => {
  it('puts the first visit at the front', () => {
    const r = visiting('1::#a');
    expect(r.keys).toEqual(['1::#a']);
  });

  it('keeps the most-recent visit at index 0 (newest first)', () => {
    const r = visiting('1::#a', '1::#b', '1::#c');
    expect(r.keys).toEqual(['1::#c', '1::#b', '1::#a']);
  });

  it('moves a revisited buffer to the front instead of duplicating it', () => {
    const r = visiting('1::#a', '1::#b', '1::#c', '1::#a');
    expect(r.keys).toEqual(['1::#a', '1::#c', '1::#b']);
  });

  it('is a no-op when re-recording the buffer already at the front', () => {
    const r = visiting('1::#a', '1::#b');
    expect(recordRecent(r, '1::#b')).toBe(false);
    expect(r.keys).toEqual(['1::#b', '1::#a']);
  });

  it('reports a change when an older entry is promoted to the front', () => {
    const r = visiting('1::#a', '1::#b');
    expect(recordRecent(r, '1::#a')).toBe(true);
    expect(r.keys).toEqual(['1::#a', '1::#b']);
  });

  it('evicts the oldest entries past the cap', () => {
    const r = createRecentBuffers();
    for (let i = 0; i < MAX_RECENT + 5; i++) recordRecent(r, `1::#c${i}`);
    expect(r.keys.length).toBe(MAX_RECENT);
    expect(r.keys[0]).toBe(`1::#c${MAX_RECENT + 4}`); // newest at front
    expect(r.keys.at(-1)).toBe('1::#c5'); // first five fell off the tail
  });
});

describe('recencyRank', () => {
  it('ranks 0 = most recent, higher = older', () => {
    const r = visiting('1::#a', '1::#b', '1::#c');
    expect(recencyRank(r, '1::#c')).toBe(0);
    expect(recencyRank(r, '1::#b')).toBe(1);
    expect(recencyRank(r, '1::#a')).toBe(2);
  });

  it('returns Infinity for a buffer never visited this session', () => {
    const r = visiting('1::#a');
    expect(recencyRank(r, '1::#never')).toBe(Infinity);
  });
});
