// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What the event loop was doing when it stalled.
//
// The stall monitor (eventLoopMonitor.ts) can say how long the loop was
// blocked, never by what: the block is synchronous, so nothing can look while
// it lasts. But whatever blocked it was some handler that then returned, and a
// handler can time itself. The two front doors do — every WebSocket frame and
// every HTTP request — and the longest one that just ended is named on the
// stall line. A label is the frame type or the route pattern, never a value
// from the request: this goes to the console of a hosted cell.

/** Shorter than this is not worth remembering: the monitor warns at 500 ms. */
const NOTABLE_MS = 100;
/** A stall line is written within a poll (1 s) of the stall's end; work that
 *  ended longer ago than this belongs to no stall being reported now. */
const RECENT_MS = 3000;

let longest: { label: string; ms: number; endedAt: number } | null = null;

/** Record that `label` held the event loop for `ms`, ending now. */
export function noteSyncWork(label: string, ms: number): void {
  if (ms < NOTABLE_MS) return;
  const now = performance.now();
  if (longest && now - longest.endedAt <= RECENT_MS && longest.ms >= ms) return;
  longest = { label, ms, endedAt: now };
}

/** Run `fn` and record how long it held the loop: its synchronous part only,
 *  which is the part that blocks. */
export function timeSyncWork<T>(label: string | (() => string), fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - start;
    if (ms >= NOTABLE_MS) noteSyncWork(typeof label === 'function' ? label() : label, ms);
  }
}

/** The longest handler that just ended, for a stall line; null if none did.
 *  Read once: the next stall is another's. */
export function describeRecentSyncWork(): string | null {
  const work = longest;
  longest = null;
  if (!work || performance.now() - work.endedAt > RECENT_MS) return null;
  return `longest handler just before: ${work.label} (${Math.round(work.ms)}ms)`;
}
