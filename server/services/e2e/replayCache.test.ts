// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import { ReplayCache } from './replayCache.js';

describe('ReplayCache', () => {
  it('observes a fresh key once, then flags a replay within the ttl', () => {
    let t = 0;
    const c = new ReplayCache(100, () => t);
    expect(c.observe('k', 1000)).toBe(true); // fresh
    expect(c.observe('k', 1000)).toBe(false); // live replay
    t = 1001;
    expect(c.observe('k', 1000)).toBe(true); // expired → fresh again
  });

  it('evicts the oldest entry when over capacity', () => {
    let t = 0;
    const c = new ReplayCache(2, () => t);
    c.observe('a', 10_000);
    c.observe('b', 10_000);
    expect(c.observe('b', 10_000)).toBe(false); // b still live
    c.observe('c', 10_000); // size 3 > cap 2 → evict oldest (a)
    expect(c.observe('a', 10_000)).toBe(true); // a was evicted → fresh
  });
});
