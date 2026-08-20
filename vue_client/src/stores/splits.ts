// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { useBuffersStore, bufferKey } from './buffers.js';

// How many buffers can share the desktop chat frame at once. Four is the point
// where a pane stops being able to show a useful number of message rows beside
// its own nicklist, so it's the ceiling rather than an arbitrary round number.
export const MAX_PANES = 4;

// The frame is a 2x2 grid and every layout is a way of filling it, so a pane's
// position is one of these area names and the layout is just which template the
// pane count selects (see PANE_AREAS / the grid templates in DesktopChat):
//
//   1 pane    2 panes   3 panes   4 panes
//   ┌─────┐   ┌─────┐   ┌─────┐   ┌──┬──┐
//   │  a  │   │  a  │   │  a  │   │a │b │
//   │     │   ├─────┤   ├──┬──┤   ├──┼──┤
//   │     │   │  b  │   │b │c │   │c │d │
//   └─────┘   └─────┘   └──┴──┘   └──┴──┘
//
// Splitting the BOTTOM half first (rather than the right) is what makes the
// third pane an addition instead of a re-layout: panes a and b keep their
// full width, and only b's height changes.
export const PANE_AREAS = ['a', 'b', 'c', 'd'] as const;

interface SplitsState {
  // Buffer keys, in layout order — index 0 is area 'a', 1 is 'b', and so on.
  // Empty before the first buffer is opened.
  panes: string[];
  // Index into `panes` of the pane that has the user's attention. Everything
  // outside the frame (the sidebar highlight, scoped search, the keyboard
  // shortcuts) still asks "what is the active buffer" and gets this pane's, so
  // focus is what keeps a split layout coherent with the rest of the app.
  focused: number;
}

export const useSplitsStore = defineStore('splits', {
  state: (): SplitsState => ({
    panes: [],
    focused: 0,
  }),
  getters: {
    count: (state): number => state.panes.length,
    // True once the frame is actually divided. The single-pane case must stay
    // pixel-identical to the pre-split shell, so this gates the split-only
    // chrome (focus ring, per-pane close button) rather than the panes.
    isSplit: (state): boolean => state.panes.length > 1,
    focusedKey: (state): string | null => state.panes[state.focused] ?? null,
    canAdd: (state): boolean => state.panes.length < MAX_PANES,
    isOpen:
      (state) =>
      (key: string): boolean =>
        state.panes.includes(key),
  },
  actions: {
    // Replace the pane set wholesale, tearing down whatever left the screen.
    //
    // Every mutation below funnels through here so the leave-lifecycle is
    // decided in exactly one place: a buffer that is in `panes` before and not
    // after has genuinely stopped being read, which is what buffers.leaveBuffer
    // means. Doing it per-action instead invites the case where one action
    // forgets and a closed pane's buffer keeps a stale unread divider forever.
    setPanes(next: string[], nextFocused: number) {
      const departed = this.panes.filter((k) => !next.includes(k));
      this.panes = next;
      // Clamp rather than trust the caller: a removal can leave `focused`
      // pointing past the end, and a focus index outside the array would make
      // focusedKey null and blank the sidebar highlight.
      this.focused = next.length === 0 ? 0 : Math.min(Math.max(nextFocused, 0), next.length - 1);
      const buffers = useBuffersStore();
      for (const key of departed) buffers.leaveBuffer(key);
    },
    // A plain (un-modified) buffer-list click, and the destination of every
    // other "go to this buffer" path in the app: show `key` in the focused
    // pane. The rest of the layout is left alone — a plain click swaps the pane
    // you're looking at, it doesn't tear the split down.
    show(key: string) {
      const at = this.panes.indexOf(key);
      // Already on screen: this is a focus move, not a swap. Nothing departs,
      // so no pane loses its divider.
      if (at !== -1) {
        this.focused = at;
        return;
      }
      if (this.panes.length === 0) {
        this.setPanes([key], 0);
        return;
      }
      const next = [...this.panes];
      next[this.focused] = key;
      this.setPanes(next, this.focused);
    },
    // Cmd/Ctrl-click: give `key` a pane of its own beside the others, and focus
    // it. At the ceiling there's nowhere to put it, so it takes over the
    // focused pane instead — the pane wearing the focus ring, so the one the
    // user is looking at is the one that visibly changes.
    addPane(key: string) {
      const at = this.panes.indexOf(key);
      if (at !== -1) {
        this.focused = at;
        return;
      }
      if (this.panes.length >= MAX_PANES) {
        this.show(key);
        return;
      }
      this.setPanes([...this.panes, key], this.panes.length);
    },
    // Close one pane. The survivors keep their order, so the layout collapses
    // predictably (closing 'a' of three promotes 'b' to the full-width top
    // slot). Focus lands on the pane that takes the closed one's index, or the
    // new last pane when it was the tail.
    closePane(index: number) {
      if (index < 0 || index >= this.panes.length) return;
      const next = this.panes.filter((_, i) => i !== index);
      // Focus follows the closed slot rather than resetting to 0: after closing
      // the pane you were in, the neighbour that slides into its place is the
      // one your attention is already on.
      const nextFocused = this.focused > index ? this.focused - 1 : this.focused;
      this.setPanes(next, nextFocused);
    },
    // Drop every pane but one — the "maximize this pane" affordance, and the
    // only way back to a single pane. A plain click deliberately does NOT do
    // this: it swaps the focused pane's buffer and leaves the split standing.
    collapseTo(index: number) {
      const key = this.panes[index];
      if (key === undefined) return;
      this.setPanes([key], 0);
    },
    focusPane(index: number) {
      if (index < 0 || index >= this.panes.length) return;
      this.focused = index;
    },
    // Reconcile with an activation that didn't come through this store —
    // /query, the quick switcher, a jump-to-message, a push deep link, the
    // land-on-system-buffer rule. They all set networks.activeKey and expect
    // the frame to follow, which for a split frame means "in the focused pane".
    syncActive(key: string | null) {
      if (!key) return;
      this.show(key);
    },
    // --- buffer lifecycle (lib/bufferLifecycle.ts) ---
    //
    // Panes are keyed by buffer, so this store keys per-buffer state and has to
    // join the lifecycle sweep like every other store that does. Without it a
    // pane holding a closed buffer renders a shell no click can fix, and a pane
    // holding a RENAMED one silently stops tracking the conversation it's
    // showing — and a rename swaps one key for another, so nothing watching the
    // buffer count would even notice.

    /** The buffer is gone: close whichever pane was showing it. */
    dropBuffer(networkId: number | string | null, target: string) {
      if (networkId == null) return; // the system buffer is permanent
      const at = this.panes.indexOf(bufferKey(networkId, target));
      if (at !== -1) this.closePane(at);
    },

    /** The buffer changed names: the pane follows it, keeping its slot. */
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      if (networkId == null) return;
      const fromKey = bufferKey(networkId, from);
      const toKey = bufferKey(networkId, to);
      if (fromKey === toKey) return;
      const at = this.panes.indexOf(fromKey);
      if (at === -1) return;
      // A merge can rename one open buffer onto another that's also open, which
      // would leave two panes on one conversation. The destination pane wins —
      // matching the destination-wins merge in the other rekey hooks — and the
      // source pane closes.
      if (this.panes.includes(toKey)) {
        this.closePane(at);
        return;
      }
      // Assigned in place rather than through setPanes: this is the same buffer
      // under a new name, so nothing left the screen and nothing should be torn
      // down.
      this.panes[at] = toKey;
    },
  },
});
