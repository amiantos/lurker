// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Pure mechanics for the back/forward buffer-navigation stack (#309). Browser
// history semantics: visiting a buffer pushes onto the stack and discards any
// forward branch; back/forward just walk a cursor without mutating the stack.
// Kept free of Vue/Pinia/store deps so the cursor edge cases (consecutive-dupe
// collapse, forward-branch truncation, cap eviction, dead-target skipping) are
// unit-testable in isolation — the navHistory store wires this to
// networks.activeKey and to buffer activation.

// Stack entries are activeKey strings exactly as networks.activeKey holds them:
// `${networkId}::${target}` for real buffers, or a bare sentinel (:system:,
// :friends:) for the virtual panes.
export interface NavHistory {
  stack: string[];
  index: number; // cursor into stack; -1 when empty
}

// Cap the retained trail. Back/forward is a convenience for recent hops, not an
// audit log — an unbounded stack would pin every buffer key the session ever
// touched in memory for no user benefit.
export const MAX_HISTORY = 100;

export function createNavHistory(): NavHistory {
  return { stack: [], index: -1 };
}

// Record a user-initiated visit to `key`. Returns true when the stack changed.
// Re-entering the buffer already at the cursor is a no-op (no consecutive
// dupes); navigating somewhere new from a back position drops the forward branch.
export function recordVisit(h: NavHistory, key: string): boolean {
  if (h.stack[h.index] === key) return false;
  if (h.index < h.stack.length - 1) h.stack.splice(h.index + 1);
  h.stack.push(key);
  h.index = h.stack.length - 1;
  if (h.stack.length > MAX_HISTORY) {
    const drop = h.stack.length - MAX_HISTORY;
    h.stack.splice(0, drop);
    h.index -= drop;
  }
  return true;
}

// Resolve where a back (delta -1) or forward (delta +1) step should land,
// skipping entries whose buffer no longer exists (parted channel, closed DM).
// Returns the destination index, or -1 when there's no live target that way —
// the caller leaves the cursor put and the keypress is a no-op.
export function stepIndex(h: NavHistory, delta: number, exists: (key: string) => boolean): number {
  let i = h.index;
  for (;;) {
    const next = i + delta;
    if (next < 0 || next >= h.stack.length) return -1;
    i = next;
    if (exists(h.stack[i])) return i;
  }
}
