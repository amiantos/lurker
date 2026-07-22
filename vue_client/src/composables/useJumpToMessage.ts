// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Ref } from 'vue';
import { watch, nextTick } from 'vue';
import { useBuffersStore } from '../stores/buffers.js';
import { useToastsStore } from '../stores/toasts.js';

// Drive MessageList's pendingScrollId watcher. Arming the same id twice in a row
// would be a no-op (the value doesn't change), so a second tap on the same
// notification — or a retry after a first attempt that landed before the row
// mounted — would silently do nothing. Bounce through null on a repeat so the
// watcher always re-fires.
function armScroll(pendingScrollId: Ref<number | null> | undefined, messageId: number): void {
  if (!pendingScrollId) return;
  if (pendingScrollId.value === messageId) {
    pendingScrollId.value = null;
    nextTick(() => {
      // Only re-arm if nothing claimed the slot during the tick — a different
      // jump firing before this microtask must not be clobbered back to our id.
      if (pendingScrollId.value === null) pendingScrollId.value = messageId;
    });
    return;
  }
  pendingScrollId.value = messageId;
}

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

    // Resolve case-insensitively (#327): the jump target may be the raw
    // server-cased name (push deep-link, search hit) while the buffer is stored
    // under a different casing. An exact-key byKey() would miss it, skipping the
    // in-memory scroll fast path and stranding the message-landed watch on a
    // null buffer. findByTarget folds to the canonical buffer activate() opened.
    const buf = buffers.findByTarget(networkId, target) as any;
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
      armScroll(pendingScrollId, messageId);
      return;
    }
    // Detached fetch path. loadAround sets detached=true synchronously (any live
    // fanOut between here and the response is dropped) and returns OUR request
    // token, or null if the socket was closed so no slice will ever arrive.
    const token = buffers.loadAround(networkId, target, messageId);
    if (token == null) {
      // Socket was closed, so the history slice can't be sent and will never
      // arrive — the buffer is activated but we can't scroll. Say so rather than
      // failing as a silent no-op (mirrors ChannelListModal's join feedback).
      toasts.push({
        kind: 'warn',
        title: 'Not connected',
        body: "Can't load that message while disconnected.",
        ttlMs: 5000,
      });
      return;
    }
    // Arm off the token, not loadingHistory: an in-flight older/newer pager
    // (prependHistory/appendHistory) clears loadingHistory with no token guard,
    // which would trip a loadingHistory watch, fail the membership check, and
    // stop() us before our slice ever lands. Only the token-matched
    // applyAroundSlice nulls pendingHistoryToken, so watching it ignores the
    // pagers; a newer jump supersedes us by setting it to a different token.
    const stop = watch(
      () => buf?.pendingHistoryToken,
      (pending) => {
        if (pending === token) return; // our request still in flight
        stop();
        if (pending != null) return; // superseded by a newer jump — it owns the UI now
        if (buf?.messages?.some((m: any) => m.id === messageId)) {
          armScroll(pendingScrollId, messageId);
          return;
        }
        // Token nulled but our row never arrived. Two ways here: the socket
        // dropped mid-flight and the close sweep (failInFlightHistory) failed
        // the request, or the slice landed without the anchor row (message no
        // longer exists server-side). Either way the user's jump silently
        // evaporates onto the live tail — mirror the feedback the
        // socket-already-closed branch above gives.
        toasts.push({
          kind: 'warn',
          title: 'Couldn’t load that message',
          body: 'The connection dropped, or the message is no longer available.',
          ttlMs: 5000,
        });
      },
    );
  };
}
