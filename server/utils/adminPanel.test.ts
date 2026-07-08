// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseNewAdminPanel } from './adminPanel.js';

describe('parseNewAdminPanel', () => {
  it('defaults to off when unset or blank', () => {
    expect(parseNewAdminPanel(undefined)).toBe(false);
    expect(parseNewAdminPanel('')).toBe(false);
    expect(parseNewAdminPanel('   ')).toBe(false);
  });

  it('accepts truthy values, case- and whitespace-insensitively', () => {
    expect(parseNewAdminPanel('1')).toBe(true);
    expect(parseNewAdminPanel('true')).toBe(true);
    expect(parseNewAdminPanel('yes')).toBe(true);
    expect(parseNewAdminPanel('on')).toBe(true);
    expect(parseNewAdminPanel('  On ')).toBe(true);
    expect(parseNewAdminPanel('TRUE')).toBe(true);
  });

  it('treats anything else as off', () => {
    expect(parseNewAdminPanel('0')).toBe(false);
    expect(parseNewAdminPanel('false')).toBe(false);
    expect(parseNewAdminPanel('no')).toBe(false);
    expect(parseNewAdminPanel('enabled')).toBe(false);
  });
});
