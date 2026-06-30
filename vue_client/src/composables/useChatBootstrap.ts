// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { onMounted } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { startPresenceReporter, reportNow } from './usePresence.js';
import { registerSW, onSWPushMessage } from './usePush.js';
import { startAppBadge } from './useAppBadge.js';

export interface JumpPayload {
  kind: string;
  networkId: number;
  target: string;
  // Absent for an "open this conversation" tap (e.g. a friend-online push).
  messageId?: number | null;
}

export interface ChatBootstrapOptions {
  onJump?: (data: JumpPayload) => void;
}

// Shared post-login bootstrap for the chat shells (Desktop + Mobile).
// onJump receives { networkId, target, messageId } when a push notification
// is clicked; each shell wires up its own handler since the mobile shell
// also needs to advance its screen state.
export function useChatBootstrap({ onJump }: ChatBootstrapOptions = {}): void {
  const networks = useNetworksStore();
  const settings = useSettingsStore();

  onMounted(async () => {
    if (!settings.loaded) settings.fetchAll().catch(() => {});
    await networks.fetchAll();
    startPresenceReporter();
    reportNow();
    // Mirror the unread-highlight total onto the PWA app icon (#451). Idempotent
    // and feature-detected — a no-op where the Badging API is unavailable.
    startAppBadge();
    // Register unconditionally so a previously-subscribed device can still
    // receive push events without re-opening Settings. Per-client subscribe
    // is gated by an explicit Settings button (see usePush.enable()).
    registerSW().catch(() => {
      /* ignore */
    });
    if (onJump) {
      onSWPushMessage((data) => {
        const d = data as any;
        if (d?.kind === 'jump') onJump(d as JumpPayload);
      });
    }
  });
}
