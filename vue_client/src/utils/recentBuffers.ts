// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Pure mechanics for the most-recently-used (MRU) buffer list that feeds the
// quick switcher's tiered smart sort (#393). A cousin of the back/forward nav
// stack (utils/navHistory, #309) — both hang off the same networks.activeKey
// signal — but a different shape: this is a move-to-front, deduped recency list
// (most recent at index 0), not a cursor stack with a forward branch. Kept free
// of Vue/Pinia so the move-to-front, cap, and ranking edge cases are unit-
// testable in isolation; the recentBuffers store wires it to networks.activeKey.

// activeKey strings exactly as networks.activeKey holds them:
// `${networkId}::${target}` for real buffers, or a bare sentinel (:system:,
// :friends:) for the virtual panes.
export interface RecentBuffers {
  keys: string[]; // most-recent first
}

// Cap the retained recency trail. The switcher reads only the first few
// (the recent tier window) plus does rank lookups for ordering the pinned tier,
// so a long tail buys nothing; keep enough that pinned-by-recency stays
// meaningful across a session without growing unbounded.
export const MAX_RECENT = 50;

export function createRecentBuffers(): RecentBuffers {
  return { keys: [] };
}

// Record a visit to `key`: move it to the front (deduping any earlier mention),
// then trim the tail to the cap. Returns true when the list changed —
// re-visiting the key already at the front is a no-op so a flush:'sync' watcher
// firing on an unrelated activeKey settle doesn't churn the list.
export function recordRecent(r: RecentBuffers, key: string): boolean {
  if (r.keys[0] === key) return false;
  const existing = r.keys.indexOf(key);
  if (existing !== -1) r.keys.splice(existing, 1);
  r.keys.unshift(key);
  if (r.keys.length > MAX_RECENT) r.keys.length = MAX_RECENT;
  return true;
}

// Recency rank of `key`: 0 = most recent, higher = older, Infinity = unvisited
// this session. Drives both the pinned tier's ordering and recent-tier
// membership in the switcher's smart sort.
export function recencyRank(r: RecentBuffers, key: string): number {
  const i = r.keys.indexOf(key);
  return i === -1 ? Infinity : i;
}
