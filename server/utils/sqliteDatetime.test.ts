// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { sqliteUtcToIso } from './sqliteDatetime.js';

describe('sqliteUtcToIso', () => {
  it("turns datetime('now')'s form into ISO 8601 UTC", () => {
    expect(sqliteUtcToIso('2026-01-02 03:04:05')).toBe('2026-01-02T03:04:05Z');
    expect(Date.parse(sqliteUtcToIso('2026-01-02 03:04:05')!)).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
  });

  it('keeps fractional seconds', () => {
    expect(sqliteUtcToIso('2026-01-02 03:04:05.250')).toBe('2026-01-02T03:04:05.250Z');
  });

  it('is null for nothing and for something that is not a datetime', () => {
    expect(sqliteUtcToIso(null)).toBeNull();
    expect(sqliteUtcToIso(undefined)).toBeNull();
    expect(sqliteUtcToIso('')).toBeNull();
    expect(sqliteUtcToIso('not a date')).toBeNull();
  });
});
