// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { unreadLabel } from './unreadLabel.js';

describe('unreadLabel', () => {
  it('renders the count as-is up to 999 and caps above it', () => {
    expect(unreadLabel(0)).toBe('0');
    expect(unreadLabel(1)).toBe('1');
    expect(unreadLabel(999)).toBe('999');
    expect(unreadLabel(1000)).toBe('>999');
    expect(unreadLabel(1500)).toBe('>999');
  });
});
