// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseSearchQuery } from './searchQuery.js';

describe('parseSearchQuery', () => {
  it('peels structured filters off the free text', () => {
    const p = parseSearchQuery('from:alice in:#dev on:libera hello world');
    expect(p).toEqual({ query: 'hello world', from: ['alice'], in: '#dev', on: 'libera' });
  });

  it('collects multiple from: into an array (OR over nicks)', () => {
    const p = parseSearchQuery('from:eren from:nostimo from:twomoon needle');
    expect(p.from).toEqual(['eren', 'nostimo', 'twomoon']);
    expect(p.query).toBe('needle');
  });

  it('defaults from to an empty array and leaves bare/unknown tokens as free text', () => {
    const p = parseSearchQuery('from: word: just text');
    expect(p.from).toEqual([]);
    expect(p.query).toBe('from: word: just text');
  });
});
