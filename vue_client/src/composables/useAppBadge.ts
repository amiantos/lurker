// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { effectScope, watch } from 'vue';
import { useBuffersStore } from '../stores/buffers.js';

// One detached effect scope holds the badge watcher for the whole session.
// Tracking it here doubles as the idempotency guard (start once) and keeps the
// watcher alive across chat-shell remounts (logout→login) — a watcher created
// directly inside onMounted would be disposed with that component instance.
let scope: ReturnType<typeof effectScope> | null = null;

function badgeSupported(): boolean {
  return typeof navigator !== 'undefined' && 'setAppBadge' in navigator;
}

// Reflect `count` on the app icon. >0 sets the badge; 0 clears it (clearAppBadge,
// not setAppBadge(0)). setAppBadge and clearAppBadge ship together as one
// NavigatorBadge mixin, so badgeSupported() gates both. They reject (not throw)
// on failure, and there's nothing useful to do about it — swallow. Mirrors
// syncAppBadge in public/sw.js — keep the two in lockstep.
function applyBadge(count: number): void {
  if (!badgeSupported()) return;
  const op = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  void op.catch(() => {});
}

// Mirror the app-wide unread-highlight total onto the PWA app icon (#451).
// Idempotent and feature-detected: unsupported browsers never wire anything and
// are a silent no-op. Safe to call from every chat-shell mount.
export function startAppBadge(): void {
  if (scope || !badgeSupported()) return;
  scope = effectScope(true);
  scope.run(() => {
    const buffers = useBuffersStore();
    // The change-only watcher below is one of TWO writers of the app-icon badge:
    // the service worker also writes it from push payloads (syncAppBadge in
    // public/sw.js) while the app is hidden/closed — the exact window this
    // in-page watcher can't reach. So the badge can be left showing a count the
    // store never matches once the app returns to the foreground with an
    // unchanged total (the watcher only fires on a CHANGE, so it never re-clears
    // it). Re-assert the current store total whenever the page returns to the
    // foreground, so the page always wins over a stale service-worker write (#463).
    watch(() => buffers.totalHighlights, applyBadge, { immediate: true });
    // Two return-to-foreground signals, mirroring usePresence's listener set:
    // visibilitychange covers a tab/PWA that was document.hidden (mobile,
    // minimized, tab-discarded); window focus covers a desktop PWA window that
    // stayed visibilityState='visible' but lost focus — e.g. across an OS sleep
    // where the socket dropped — which fires no visibilitychange on return. The
    // !document.hidden guard keeps focus-while-hidden a no-op. These live for the
    // whole session (the detached scope is never stopped — see above), which is
    // correct: they must survive logout→login and keep reconciling.
    if (typeof document !== 'undefined') {
      const reconcile = () => {
        if (!document.hidden) applyBadge(buffers.totalHighlights);
      };
      document.addEventListener('visibilitychange', reconcile);
      window.addEventListener('focus', reconcile);
    }
  });
}

// Force-clear the badge on logout. The detached watcher would re-clear once the
// store $resets to a 0 total anyway, but clearing explicitly avoids a stale
// count lingering on the icon between sessions.
export function clearAppBadgeNow(): void {
  applyBadge(0);
}
