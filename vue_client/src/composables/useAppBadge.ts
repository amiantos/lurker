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
// not setAppBadge(0)). The Badging API returns a promise that can reject (and a
// few engines throw synchronously), none of which we can act on — swallow both.
function applyBadge(count: number): void {
  if (!badgeSupported()) return;
  try {
    if (count > 0) {
      void navigator.setAppBadge(count).catch(() => {});
    } else if ('clearAppBadge' in navigator) {
      void navigator.clearAppBadge().catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

// Mirror the app-wide unread-highlight total onto the PWA app icon (#451).
// Idempotent and feature-detected: unsupported browsers never wire anything and
// are a silent no-op. Safe to call from every chat-shell mount.
export function startAppBadge(): void {
  if (scope || !badgeSupported()) return;
  scope = effectScope(true);
  scope.run(() => {
    const buffers = useBuffersStore();
    watch(() => buffers.totalHighlights, applyBadge, { immediate: true });
  });
}

// Force-clear the badge on logout. The detached watcher would re-clear once the
// store $resets to a 0 total anyway, but clearing explicitly avoids a stale
// count lingering on the icon between sessions.
export function clearAppBadgeNow(): void {
  applyBadge(0);
}
