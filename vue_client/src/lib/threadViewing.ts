// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The buffer whose reply thread is on screen instead of its lines, or null.
// The thread view keeps its channel the ACTIVE buffer (so the sidebar, the
// composer and the status bar stay on it), but the channel's own lines aren't
// in view — so a live line there must not be marked read (buffers.pushLive).
// A plain module variable, like useViewedBuffer's: the reader polls it as each
// line arrives. Set by the threads store as the view opens and closes.
let key: string | null = null;

export function setThreadViewBuffer(next: string | null): void {
  key = next;
}

export function threadViewBuffer(): string | null {
  return key;
}
