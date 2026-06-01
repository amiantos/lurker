// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi } from 'vitest';
import { parseEdition } from './edition.js';

describe('parseEdition', () => {
  it('defaults to standalone when unset or blank', () => {
    expect(parseEdition(undefined)).toBe('standalone');
    expect(parseEdition('')).toBe('standalone');
    expect(parseEdition('   ')).toBe('standalone');
  });

  it('accepts the known editions, case- and whitespace-insensitively', () => {
    expect(parseEdition('standalone')).toBe('standalone');
    expect(parseEdition('node')).toBe('node');
    expect(parseEdition('NODE')).toBe('node');
    expect(parseEdition('  Node ')).toBe('node');
  });

  it('warns and falls back to standalone on an unknown value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseEdition('cell')).toBe('standalone');
    expect(parseEdition('hosted')).toBe('standalone');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
