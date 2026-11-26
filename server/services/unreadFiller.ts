// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Builds the stored unread count (db/unreadCounts.ts) for a buffer whose unread
// range is too long to count in one statement: one bounded chunk at a time,
// yielding between chunks so WS fan-out and the IRC sockets are served
// (better-sqlite3 is synchronous), and resting as long as each chunk took. Where each buffer's walk has got to lives in
// its row, so there is nothing here to lose on a restart.
//
// A buffer lands in the queue when a read or a mark-read finds more unread than
// it can count (most often once per deep buffer, the first time it is asked
// about after the upgrade that added the count). Until its fill finishes, its
// badge shows the capped walk; `onUnreadFilled` then lets the hub serve the
// whole number.

import {
  dropUnreadFill,
  fillUnreadStep,
  nextFillBuffer,
  queueInterruptedFills,
  setUnreadFillWaker,
} from '../db/unreadCounts.js';

let filled: (bufferId: number) => void = () => {};

/** Called with a buffer's id when its count has just become whole. */
export function onUnreadFilled(fn: (bufferId: number) => void): void {
  filled = fn;
}

/** The longest pause between chunks, however slow the last one was. */
const MAX_REST_MS = 250;

let pumping = false;

function pump(): void {
  if (pumping) return;
  pumping = true;
  setImmediate(step);
}

function step(): void {
  const bufferId = nextFillBuffer();
  if (bufferId === undefined) {
    pumping = false;
    return;
  }
  const started = performance.now();
  try {
    if (fillUnreadStep(bufferId) === 'done') filled(bufferId);
  } catch (err) {
    // Leave the buffer uncounted (its badge keeps the capped walk) rather than
    // retry a failing statement every turn; the next read queues it again.
    dropUnreadFill(bufferId);
    console.warn(`[unread] fill failed for buffer ${bufferId}:`, (err as Error).message);
  }
  // Rest for as long as the chunk held the loop, so a fill never takes more
  // than half of it however slow the storage. A fast chunk just yields.
  const held = performance.now() - started;
  if (held < 1) setImmediate(step);
  else setTimeout(step, Math.min(held, MAX_REST_MS));
}

/** Run every queued fill to the end, synchronously. Tests only. */
export function drainUnreadFillsForTests(): void {
  for (let id = nextFillBuffer(); id !== undefined; id = nextFillBuffer()) {
    if (fillUnreadStep(id) === 'done') filled(id);
  }
}

/** Start filling: whatever a previous process left part-built, then on demand. */
export function startUnreadFiller(): void {
  setUnreadFillWaker(pump);
  if (queueInterruptedFills() > 0 || nextFillBuffer() !== undefined) pump();
}
