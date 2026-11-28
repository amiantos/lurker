// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { hidesMutedRow } from './mutedRows.js';

const row = { hideMuted: true, muted: true, highlighted: 0, active: false, kept: false };

describe('hidesMutedRow', () => {
  it('hides a quiet muted row when the setting is on', () => {
    expect(hidesMutedRow(row)).toBe(true);
  });

  it('hides nothing with the setting off', () => {
    expect(hidesMutedRow({ ...row, hideMuted: false })).toBe(false);
  });

  it('leaves rows that are not muted', () => {
    expect(hidesMutedRow({ ...row, muted: false })).toBe(false);
  });

  it('brings a muted row back while it has a highlight', () => {
    expect(hidesMutedRow({ ...row, highlighted: 1 })).toBe(false);
  });

  it('keeps the buffer you are in, and pinned or favorited rows', () => {
    expect(hidesMutedRow({ ...row, active: true })).toBe(false);
    expect(hidesMutedRow({ ...row, kept: true })).toBe(false);
  });
});
