// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { unreadLabel } from './unreadLabel.js';

describe('unreadLabel', () => {
  it('renders the count as-is up to 999', () => {
    expect(unreadLabel(0)).toBe('0');
    expect(unreadLabel(1)).toBe('1');
    expect(unreadLabel(999)).toBe('999');
  });

  it('shortens past that, rounding down', () => {
    expect(unreadLabel(1000)).toBe('1k');
    expect(unreadLabel(1234)).toBe('1.2k');
    expect(unreadLabel(1999)).toBe('1.9k');
    expect(unreadLabel(9999)).toBe('9.9k');
    expect(unreadLabel(10_000)).toBe('10k');
    expect(unreadLabel(54_321)).toBe('54k');
    expect(unreadLabel(999_999)).toBe('999k');
    expect(unreadLabel(1_000_000)).toBe('1m');
    expect(unreadLabel(2_540_000)).toBe('2.5m');
  });
});
