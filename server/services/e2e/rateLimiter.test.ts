// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';

import { RateLimiter } from './rateLimiter.js';

describe('RateLimiter', () => {
  it('enforces a 30s outgoing gap per peer, independently', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    expect(rl.allowOutgoing('p')).toBe(true);
    expect(rl.allowOutgoing('p')).toBe(false);
    t = 29_999;
    expect(rl.allowOutgoing('p')).toBe(false);
    t = 30_000;
    expect(rl.allowOutgoing('p')).toBe(true);
    // A different peer has its own gap.
    expect(rl.allowOutgoing('q')).toBe(true);
  });

  it('allows 3 incoming per minute then backs off for 5 minutes', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    expect(rl.allowIncoming('p')).toBe(true);
    expect(rl.allowIncoming('p')).toBe(true);
    expect(rl.allowIncoming('p')).toBe(true);
    expect(rl.allowIncoming('p')).toBe(false); // 4th trips the backoff
    t = 60_000;
    expect(rl.allowIncoming('p')).toBe(false); // still inside the 5-min backoff
    t = 300_001;
    expect(rl.allowIncoming('p')).toBe(true); // backoff expired, window reset
  });

  it('keeps incoming buckets independent per peer', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 3; i++) rl.allowIncoming('p');
    expect(rl.allowIncoming('p')).toBe(false);
    expect(rl.allowIncoming('q')).toBe(true);
  });
});
