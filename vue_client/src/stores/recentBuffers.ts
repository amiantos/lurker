// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { createRecentBuffers, recordRecent, recencyRank } from '../utils/recentBuffers.js';

// Most-recently-used buffer list powering the quick switcher's smart sort
// (#393). Client-only and in-memory, like its cousin navHistory (#309): both are
// fed by the single networks.activeKey watcher in useKeyboardShortcuts, but
// where navHistory keeps a back/forward cursor stack, this keeps a move-to-front
// recency list. Unlike navHistory it records EVERY activation, including the
// programmatic back/forward hops navHistory itself ignores — landing on a buffer
// via Cmd+[ still legitimately makes it recently-used.
export const useRecentBuffersStore = defineStore('recentBuffers', {
  state: () => createRecentBuffers(),
  getters: {
    // Recency rank as a bound lookup: 0 = most recent … Infinity = unvisited.
    // Reads s.keys, so a computed calling it re-runs when the MRU changes.
    rank: (s) => (key: string) => recencyRank(s, key),
  },
  actions: {
    // The recording seam: the activeKey watcher calls this on every change.
    record(activeKey: string) {
      recordRecent(this, activeKey);
    },
  },
});
