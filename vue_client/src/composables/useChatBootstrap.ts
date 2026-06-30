// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useToastsStore } from '../stores/toasts.js';
import { startPresenceReporter, reportNow } from './usePresence.js';
import { registerSW, onSWPushMessage } from './usePush.js';
import { onJumpIntent } from './useJumpIntent.js';
import { connected } from './useSocket.js';
import { startAppBadge } from './useAppBadge.js';
import type { JumpTarget } from './useJumpToMessage.js';

// How long to wait for the app to become able to honor a cold-start deep link
// before giving up. networks.fetchAll() (REST) has resolved by the time we look,
// but buffers + the socket come up asynchronously over the WS — and loadAround()
// no-ops while the socket is closed — so we hold the jump until both land.
const COLD_START_JUMP_TIMEOUT_MS = 10000;

// The bus/notification payload is a jump target plus a `kind` discriminator
// shared with the service-worker message channel; it IS what jump() consumes.
export interface JumpPayload extends JumpTarget {
  kind: string;
}

export interface ChatBootstrapOptions {
  onJump?: (data: JumpPayload) => void;
}

// The service worker can only hand a launched-from-closed PWA its jump target
// through the URL (a postMessage would race the not-yet-registered listener and
// be dropped), so the notificationclick handler writes /?net&buf&msg. Nothing
// read it back before — the user just landed on the default screen. Recover it
// here, strip it so a refresh doesn't re-jump, and fire it through the same
// onJump the warm push path uses once the app can actually honor it. Returns a
// disposer for the deferred-readiness watch/timer.
export function consumeColdStartJump(
  buffers: ReturnType<typeof useBuffersStore>,
  onJump: (data: JumpPayload) => void,
): () => void {
  const noop = (): void => {};
  // new URLSearchParams(string) never throws, so no guard is needed.
  const params = new URLSearchParams(window.location.search);
  const net = params.get('net');
  const buf = params.get('buf');
  if (!net || !buf) return noop;
  const networkId = Number(net);
  if (!Number.isFinite(networkId)) return noop;

  const msg = params.get('msg');
  // Strip the deep-link params immediately so a manual refresh doesn't re-jump.
  params.delete('net');
  params.delete('buf');
  params.delete('msg');
  const qs = params.toString();
  window.history.replaceState(
    null,
    '',
    window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
  );

  // Validate msg the same way as networkId: a malformed ?msg=foo must become a
  // null "open the conversation" intent, not NaN — NaN slips past the
  // `messageId == null` check downstream and anchors loadAround on NaN.
  const parsed = msg != null && msg !== '' ? Number(msg) : null;
  const messageId = parsed != null && Number.isFinite(parsed) ? parsed : null;

  const payload: JumpPayload = { kind: 'jump', networkId, target: buf, messageId };
  const ready = (): boolean => connected.value && buffers.isOpen(networkId, buf);
  if (ready()) {
    onJump(payload);
    return noop;
  }

  let done = false;
  // Watch the boolean directly (not a fresh [a, b] array, which compares
  // unequal every tick) so the callback runs only when readiness actually flips.
  const stop = watch(ready, (ok) => {
    if (!ok) return;
    cleanup();
    onJump(payload);
  });
  const timer = setTimeout(() => {
    cleanup();
    // The buffer never re-opened (e.g. a channel/DM closed before the app was
    // killed). The URL is already stripped, so without this the intent would
    // vanish silently. Surface it instead of leaving the user on the default
    // screen wondering why the notification did nothing.
    useToastsStore().push({
      kind: 'info',
      title: messageId != null ? 'Couldn’t open that message' : 'Couldn’t open that conversation',
      body: '',
      ttlMs: 5000,
    });
  }, COLD_START_JUMP_TIMEOUT_MS);
  function cleanup(): void {
    if (done) return;
    done = true;
    stop();
    clearTimeout(timer);
  }
  return cleanup;
}

// Shared post-login bootstrap for the chat shells (Desktop + Mobile).
// onJump receives { networkId, target, messageId } from any of the three jump
// entry points — a clicked push notification (warm via postMessage, cold via the
// launch URL) or an in-app toast click (#444). Each shell wires up its own handler
// since the mobile shell also needs to advance its screen state.
export function useChatBootstrap({ onJump }: ChatBootstrapOptions = {}): void {
  const networks = useNetworksStore();
  const settings = useSettingsStore();
  const buffers = useBuffersStore();
  const disposers: Array<() => void> = [];

  // Wire all three jump entry points synchronously in setup so onBeforeUnmount
  // can always dispose them. Registering after the onMounted await would race a
  // fast shell unmount (Desktop<->Mobile viewport swap): cleanup would run with
  // an empty disposer list, then the awaited continuation would add listeners
  // that never get torn down — leaking them and double-firing every later jump.
  if (onJump) {
    disposers.push(
      onSWPushMessage((data) => {
        const d = data as any;
        if (d?.kind === 'jump') onJump(d as JumpPayload);
      }),
    );
    disposers.push(onJumpIntent(onJump));
    disposers.push(consumeColdStartJump(buffers, onJump));
  }

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
  });

  // The viewport-driven shell swap (Desktop <-> Mobile) remounts this composable;
  // without cleanup the old listeners would linger and double-fire every jump.
  onBeforeUnmount(() => {
    for (const dispose of disposers) dispose();
    disposers.length = 0;
  });
}
