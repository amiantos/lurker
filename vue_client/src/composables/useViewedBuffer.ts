// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The set of buffer keys (`networkId::target`) whose message lists are actually
// rendered on screen right now. Empty when none are — which covers the Settings
// route, the mobile buffer-list / members screens, and the system console.
//
// MessageList owns the registration: it retains its buffer while mounted and
// releases on unmount. With one message list on screen this is a set of at most
// one; with several windowed panes open it holds every buffer the user can
// currently see, which is exactly the question toast suppression is asking.
//
// Deliberately NOT networks.activeKey. activeKey only tracks the last-opened
// buffer and lingers across route and mobile-screen changes, so it still reads
// as "in view" while the user sits on Settings or the buffer list. Toast
// suppression keys off this instead (useHighlightNotifier.shouldNotifyInApp) so
// a highlight in the last-opened buffer still toasts while that buffer's
// messages aren't actually on screen.
//
// Refcounted rather than a plain Set: two panes may show the same buffer (or a
// pane may remount across a key change while the old one is still tearing
// down), and the first release must not blind the survivor. Plain module state,
// not a ref — the only reader, shouldNotifyInApp, polls it imperatively when an
// event arrives, so there's nothing to react to.
const viewers = new Map<string, number>();

export function retainViewedBuffer(key: string | null): void {
  if (!key) return;
  viewers.set(key, (viewers.get(key) ?? 0) + 1);
}

export function releaseViewedBuffer(key: string | null): void {
  if (!key) return;
  const next = (viewers.get(key) ?? 0) - 1;
  if (next > 0) viewers.set(key, next);
  else viewers.delete(key);
}

export function isBufferViewed(key: string): boolean {
  return viewers.has(key);
}

// Session reset (logout) tears every message list down anyway; drop the map so
// a stale key can't suppress a toast for the next user.
export function resetViewedBuffers(): void {
  viewers.clear();
}
