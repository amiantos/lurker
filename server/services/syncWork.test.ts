// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { describeRecentSyncWork, noteSyncWork, timeSyncWork } from './syncWork.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'Date', 'setTimeout', 'clearTimeout'] });
  describeRecentSyncWork();
});
afterEach(() => vi.useRealTimers());

describe('syncWork', () => {
  it('names the longest handler that just ended, once', () => {
    noteSyncWork('ws history', 800);
    noteSyncWork('GET /api/search', 4000);
    noteSyncWork('ws typing', 300);
    expect(describeRecentSyncWork()).toBe('longest handler just before: GET /api/search (4000ms)');
    expect(describeRecentSyncWork()).toBeNull();
  });

  it('forgets quick work, and work that ended too long ago to be this stall', () => {
    noteSyncWork('ws typing', 20);
    expect(describeRecentSyncWork()).toBeNull();
    noteSyncWork('ws history', 900);
    vi.advanceTimersByTime(10_000);
    expect(describeRecentSyncWork()).toBeNull();
    // And old work does not shadow newer, shorter work.
    noteSyncWork('ws history', 900);
    vi.advanceTimersByTime(10_000);
    noteSyncWork('ws mark-read', 200);
    expect(describeRecentSyncWork()).toBe('longest handler just before: ws mark-read (200ms)');
  });

  it('times the synchronous part of a handler, and lets its throw through', () => {
    expect(
      timeSyncWork('ws search', () => {
        vi.advanceTimersByTime(1500);
        return 7;
      }),
    ).toBe(7);
    expect(describeRecentSyncWork()).toBe('longest handler just before: ws search (1500ms)');
    expect(() =>
      timeSyncWork(
        () => 'ws broken',
        () => {
          vi.advanceTimersByTime(600);
          throw new Error('boom');
        },
      ),
    ).toThrow('boom');
    expect(describeRecentSyncWork()).toBe('longest handler just before: ws broken (600ms)');
  });
});
