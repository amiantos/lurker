// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { orderByTime } from './messageOrder.js';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 9, minute)).toISOString();

describe('orderByTime', () => {
  it('leaves a buffer with nothing replayed as it is, the same array', () => {
    const rows = [
      { id: 1, time: at(1) },
      { id: 2, time: at(2) },
      { id: 3, time: at(2) },
    ];
    expect(orderByTime(rows)).toBe(rows);
  });

  it('places a replayed line by its time, under the join it was stored after', () => {
    const rows = [
      { id: 10, time: at(18), text: 'before' },
      { id: 20, time: at(22), text: 'join' },
      { id: 21, time: at(19), text: 'gap one' },
      { id: 22, time: at(20), text: 'gap two' },
      { id: 23, time: at(23), text: 'after' },
    ];
    expect(orderByTime(rows).map((r) => r.text)).toEqual([
      'before',
      'gap one',
      'gap two',
      'join',
      'after',
    ]);
    // The store's array is untouched: it is the id order paging relies on.
    expect(rows.map((r) => r.id)).toEqual([10, 20, 21, 22, 23]);
  });

  it('breaks a shared time by id, and keeps a row without one where its ids put it', () => {
    const rows = [
      { id: 2, time: at(5) },
      { id: 1, time: at(5) },
      { id: 3 },
      { id: 4, time: at(6) },
    ];
    expect(orderByTime(rows).map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it('keeps a row with no id last among its time: it is being sent now', () => {
    const rows = [{ id: 2, time: at(5) }, { time: at(5) }, { id: 1, time: at(3) }];
    expect(orderByTime(rows).map((r) => r.id ?? null)).toEqual([1, 2, null]);
  });
});
