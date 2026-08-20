// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import { useBufferKey } from './useActiveBuffer.js';

// Direction from the viewport to the pinned unread divider when it's off
// screen and not yet seen this visit: 'up' = above the viewport, 'down' =
// below it. null means there's nothing to jump to — no divider, it's on
// screen, or the user already scrolled it into view this visit.
export type UnreadAnchor = 'up' | 'down' | null;

// Bridges a MessageList's scroll position into the StatusBar sitting beneath
// it, without a prop drill: MessageList writes via the setters, StatusBar reads
// the refs. Both live inside the same BufferPane, so the bridge is keyed by
// buffer — with several panes on screen each one's "N new ↓" and stick-to-bottom
// belong to its own buffer, and a scrolled-up window must not tell a pinned
// window's status bar that it's scrolled up.
interface Entry {
  stuckToBottom: Ref<boolean>;
  newBelow: Ref<number>;
  scrollToBottomToken: Ref<number>;
  unreadAnchor: Ref<UnreadAnchor>;
  scrollToUnreadToken: Ref<number>;
}

// Keyed by buffer key. The empty string stands in for "no buffer" so callers
// never have to null-check an entry. Entries are a handful of refs each and are
// bounded by the number of buffers ever opened this session; the whole map is
// dropped on session reset (logout).
const entries = new Map<string, Entry>();
const NO_BUFFER = '';

function entryFor(key: string | null): Entry {
  const k = key ?? NO_BUFFER;
  let entry = entries.get(k);
  if (!entry) {
    entry = {
      stuckToBottom: ref(true),
      newBelow: ref(0),
      scrollToBottomToken: ref(0),
      unreadAnchor: ref<UnreadAnchor>(null),
      scrollToUnreadToken: ref(0),
    };
    entries.set(k, entry);
  }
  return entry;
}

export interface ScrollState {
  stuckToBottom: ComputedRef<boolean>;
  newBelow: ComputedRef<number>;
  scrollToBottomToken: ComputedRef<number>;
  unreadAnchor: ComputedRef<UnreadAnchor>;
  scrollToUnreadToken: ComputedRef<number>;
  setStuckToBottom: (v: boolean) => void;
  bumpNewBelow: () => void;
  reset: () => void;
  requestScrollToBottom: () => void;
  setUnreadAnchor: (dir: UnreadAnchor) => void;
  requestScrollToUnread: () => void;
}

// Scroll state for this subtree's buffer. Must be called from setup(): it reads
// the injected buffer key, falling back to the global active buffer.
export function useScrollState(): ScrollState {
  const bufferKey = useBufferKey();
  const entry = () => entryFor(bufferKey.value);

  return {
    stuckToBottom: computed(() => entry().stuckToBottom.value),
    newBelow: computed(() => entry().newBelow.value),
    scrollToBottomToken: computed(() => entry().scrollToBottomToken.value),
    unreadAnchor: computed(() => entry().unreadAnchor.value),
    scrollToUnreadToken: computed(() => entry().scrollToUnreadToken.value),

    setStuckToBottom(v: boolean) {
      const e = entry();
      e.stuckToBottom.value = !!v;
      if (v) e.newBelow.value = 0;
    },
    bumpNewBelow() {
      const e = entry();
      if (!e.stuckToBottom.value) e.newBelow.value += 1;
    },
    reset() {
      const e = entry();
      e.stuckToBottom.value = true;
      e.newBelow.value = 0;
      e.unreadAnchor.value = null;
    },
    requestScrollToBottom() {
      entry().scrollToBottomToken.value += 1;
    },
    setUnreadAnchor(dir: UnreadAnchor) {
      entry().unreadAnchor.value = dir;
    },
    requestScrollToUnread() {
      entry().scrollToUnreadToken.value += 1;
    },
  };
}

// Drop every buffer's scroll state. Called on session reset (logout), where the
// buffers themselves are also going away.
export function resetAllScrollState(): void {
  entries.clear();
}
