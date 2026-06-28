// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { useBuffersStore } from './buffers.js';
import { useFriendsStore } from './friends.js';
import { FRIENDS_KEY, isVirtualKey } from '../lib/virtualBuffers.js';
import { createNavHistory, recordVisit, stepIndex } from '../utils/navHistory.js';

// True only for the synchronous span of a back()/forward() activation, so the
// networks.activeKey watcher (wired in useKeyboardShortcuts) doesn't re-record
// the programmatic hop as a fresh visit and corrupt the cursor. Module-level
// because the store is a singleton and this never needs to be reactive; it's
// always false between operations, so $reset() needn't touch it.
let navigating = false;

// Slack-style back/forward across recently-visited buffers (#309). Client-only
// and in-memory by design: no server round-trip, no persistence across reloads.
// The cursor mechanics live in utils/navHistory; this store owns the live
// wiring — recording activations (via record(), fed by the activeKey watcher)
// and dispatching a hop back through the same activation path a click takes.
export const useNavHistoryStore = defineStore('navHistory', {
  state: () => createNavHistory(),
  getters: {
    // Reachability is gated only by the boundaries here; back()/forward() may
    // still no-op if everything in that direction turns out to be a dead buffer.
    canBack: (s) => s.index > 0,
    canForward: (s) => s.index < s.stack.length - 1,
  },
  actions: {
    // The single recording seam: the activeKey watcher calls this on every
    // change. The guard drops the echo from our own back/forward navigation.
    record(activeKey: string) {
      if (navigating) return;
      recordVisit(this, activeKey);
    },
    back() {
      this.move(-1);
    },
    forward() {
      this.move(1);
    },
    move(delta: number) {
      const target = stepIndex(this, delta, (k) => this.exists(k));
      if (target === -1) return; // nothing live that way — keypress is a no-op
      this.index = target;
      navigating = true;
      try {
        this.go(this.stack[target]);
      } finally {
        navigating = false;
      }
    },
    // A virtual pane (:friends:, :system:) is always reachable; a real buffer is
    // gone once parted/closed (the buffers store deletes its entry).
    exists(activeKey: string): boolean {
      return isVirtualKey(activeKey) || !!useBuffersStore().byKey(activeKey);
    },
    // Re-activate a recorded key through the same path the original click took,
    // so the hop runs all the usual activation side effects (read pointer,
    // refetch, presence probe).
    go(activeKey: string) {
      if (activeKey === FRIENDS_KEY) {
        useFriendsStore().open();
        return;
      }
      // `${networkId}::${target}`, or a bare sentinel (:system:) with no `::`,
      // which activates as the networkId-less system buffer.
      const sep = activeKey.indexOf('::');
      if (sep === -1) useBuffersStore().activate(null, activeKey);
      else useBuffersStore().activate(Number(activeKey.slice(0, sep)), activeKey.slice(sep + 2));
    },
  },
});
