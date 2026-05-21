// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The buffer key (`networkId::target`) whose message list is actually
// rendered on screen right now, or null when none is. MessageList owns it:
// it reports its buffer while mounted and clears it on unmount — so this is
// null whenever MessageList isn't mounted, which covers the Settings route,
// the mobile buffer-list / members screens, and the system console.
//
// Deliberately NOT networks.activeKey. activeKey only tracks the last-opened
// buffer and lingers across route and mobile-screen changes, so it still
// reads as "in view" while the user sits on Settings or the buffer list.
// Toast suppression keys off this instead (useHighlightNotifier
// .shouldNotifyInApp) so a highlight in the last-opened buffer still toasts
// while that buffer's messages aren't actually on screen.
//
// A plain module variable (not a ref): the only reader, shouldNotifyInApp,
// polls it imperatively when an event arrives — there's nothing to react to.
let viewedBufferKey: string | null = null;

export function setViewedBuffer(key: string | null): void {
  viewedBufferKey = key;
}

export function viewedBuffer(): string | null {
  return viewedBufferKey;
}
