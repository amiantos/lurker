// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Folding networks in the sidebar (#1432). A network can be folded down to its
// header row two ways: by hand, per network (`collapsed`, stored on the server
// so it follows the user between devices), or all at once by accordion mode
// (`look.buffer_list.accordion`), which treats every network as folded.
//
// Either way, going into a folded network opens it for the visit and leaving
// folds it again. The visit is not stored: it follows the active buffer, so
// every way of getting somewhere (a click, Alt+arrow, the quick switcher, a
// notification) is covered and keyboard order is untouched. Folding a network
// while in it ends the visit early: it drops to its header and the one buffer
// you have open.
//
// Pure, so the rules stay unit-testable; BufferList supplies the stores.

export interface ActivePlace {
  // null for the system buffer, which belongs to no network.
  networkId: number | null;
  // Shown under FRIENDS / FAVORITES, not under its network.
  favorite: boolean;
}

export interface VisitState {
  // The network open for a visit, or null.
  open: number | null;
  // The network the active buffer was last in. A visit starts on ARRIVAL, a
  // change of this, so a visit ended by hand stays ended while you move about
  // inside the same network.
  last: number | null;
}

// The visit after the active buffer changed. A favorite or the system buffer
// is not "in" any network group, so nothing moves: stepping through favorites
// on three networks must not flap the list below.
export function stepVisit(state: VisitState, active: ActivePlace | null): VisitState {
  if (!active || active.networkId == null || active.favorite) return state;
  if (active.networkId === state.last) return state;
  return { open: active.networkId, last: active.networkId };
}

// Whether a network lists all its channels right now.
export function isNetworkOpen(net: {
  id: number;
  // Folded by hand.
  collapsed: boolean;
  // Accordion mode is on.
  accordion: boolean;
  // VisitState.open.
  openNetworkId: number | null;
}): boolean {
  if (net.openNetworkId === net.id) return true;
  return !net.collapsed && !net.accordion;
}

export interface ClosedNetworkView<T> {
  // Still listed under the closed header, in sidebar order: the buffer you
  // are in, and any with a highlight (a DM's unread lines are all highlights),
  // which stays one click away.
  rows: T[];
  // What the header's badge adds for everything not listed.
  hiddenCount: number;
  // Whether anything not listed should colour the header as unread.
  hiddenUnread: boolean;
}

// What a closed network shows. `bufs` is its channels and DMs in sidebar
// order, server buffer excluded. `count` and `countsAsUnread` are the list's
// own per-row rules (display mode, mutes), so the roll-up can't disagree with
// what the rows would have said.
export function closedNetworkView<T extends { highlighted: number }>(
  bufs: T[],
  rules: {
    count: (buf: T) => number;
    countsAsUnread: (buf: T) => boolean;
    isActive: (buf: T) => boolean;
  },
): ClosedNetworkView<T> {
  const rows: T[] = [];
  let hiddenCount = 0;
  let hiddenUnread = false;
  for (const buf of bufs) {
    if (buf.highlighted > 0 || rules.isActive(buf)) {
      rows.push(buf);
      continue;
    }
    hiddenCount += rules.count(buf);
    if (rules.countsAsUnread(buf)) hiddenUnread = true;
  }
  return { rows, hiddenCount, hiddenUnread };
}
