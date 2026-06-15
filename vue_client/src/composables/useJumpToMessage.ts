// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Ref } from 'vue';
import { watch } from 'vue';
import { useBuffersStore } from '../stores/buffers.js';
import { useToastsStore } from '../stores/toasts.js';

export interface JumpTarget {
  networkId: number;
  target: string;
  // Omitted for an "open this conversation" intent (e.g. a friend-online push)
  // — there's no specific message to scroll to, just the buffer to open.
  messageId?: number | null;
}

export interface JumpToMessageOptions {
  pendingScrollId?: Ref<number | null>;
  afterActivate?: () => void;
}

// Shared jump-to-message logic for both desktop and mobile shells. The
// shell-specific tail (mobile flips `screen.value = 'buffer'`; desktop has
// no such state) is left to the caller — they pass the `pendingScrollId`
// ref so we can drive the existing MessageList watcher and an optional
// `afterActivate` callback for any post-activate UI work.
//
// Behavior:
//   1. Reject :server: pseudo-buffers (no per-message anchor).
//   2. Reject closed buffers with the existing toast.
//   3. Activate the buffer.
//   4. If the target id is already in buf.messages AND not hidden by the
//      /clear marker, set pendingScrollId directly (current happy path; no
//      fetch needed).
//   5. Otherwise, loadAround() — detaching the buffer to a bounded ~200-row
//      historical slice — and arm pendingScrollId once the slice lands.
//      Detached mode suppresses the /clear filter in MessageList, so a row
//      below the marker becomes visible without disturbing the marker.
export function useJumpToMessage({ pendingScrollId, afterActivate }: JumpToMessageOptions = {}): (
  args: JumpTarget,
) => void {
  const buffers = useBuffersStore();
  const toasts = useToastsStore();

  return function jumpToMessage({ networkId, target, messageId }: JumpTarget): void {
    if (typeof target === 'string' && target.startsWith(':server:')) {
      toasts.push({ kind: 'info', title: 'Cannot jump in server buffer', ttlMs: 4000 } as any);
      return;
    }
    // No specific message — an "open this conversation" intent (a friend-online
    // push tap). Just activate the DM, creating its buffer if needed; skip the
    // closed-buffer guard and the loadAround scroll path entirely.
    if (messageId == null) {
      buffers.activate(networkId, target);
      if (typeof afterActivate === 'function') afterActivate();
      return;
    }
    // A notification can outlive its buffer — if the channel was closed
    // since the push fired, activating would recreate an empty shell. Bail
    // with a toast instead of stranding the UI in a half-state.
    if (!buffers.isOpen(networkId, target)) {
      toasts.push({ kind: 'info', title: 'Buffer is closed', ttlMs: 4000 } as any);
      return;
    }
    buffers.activate(networkId, target);
    if (typeof afterActivate === 'function') afterActivate();

    const buf = buffers.byKey(`${networkId}::${target}`) as any;
    const hasMessage = buf?.messages?.some((m: any) => m.id === messageId);
    // A row at or below the /clear marker is loaded but filtered out at
    // render time. Detaching the buffer suppresses the filter — no fetch
    // needed since the row is already in memory — and the next render pass
    // mounts the DOM node pendingScrollId is waiting to scroll to.
    const hiddenByClear =
      typeof buf?.clearedBeforeId === 'number' &&
      buf.clearedBeforeId > 0 &&
      messageId <= buf.clearedBeforeId;
    if (hasMessage) {
      if (hiddenByClear) buffers.detachForJump(networkId, target);
      if (pendingScrollId) pendingScrollId.value = messageId;
      return;
    }
    // Detached fetch path. loadAround sets detached=true synchronously, so
    // any live fanOut between here and the response is dropped. We arm
    // pendingScrollId once the slice replaces buf.messages — the MessageList
    // watcher then handles the scroll/pulse.
    buffers.loadAround(networkId, target, messageId);
    const stop = watch(
      () => buf?.messages?.length,
      (len) => {
        if (!len) return;
        // The around response replaces messages wholesale, so the first
        // non-empty change after dispatch is the slice landing.
        stop();
        if (pendingScrollId) pendingScrollId.value = messageId;
      },
    );
  };
}
