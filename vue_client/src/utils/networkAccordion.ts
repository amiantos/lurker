// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Folding networks in the sidebar (#1432). A network can be folded down to its
// header row two ways: by hand, per network (`collapsed`, stored on the server
// so it follows the user between devices), or all at once by accordion mode
// (`look.buffer_list.accordion`), which treats every network as folded.
//
// Neither hides where you are. A network folded by hand still lists the
// buffer you are in, and only that one, so folding the network you are sitting
// in visibly does something. Accordion mode goes further and shows the network
// you are in fully open. Both follow the active buffer and nothing about that
// is stored, so every way of getting somewhere (a click, Alt+arrow, the quick
// switcher, a notification) is covered and keyboard order is untouched.
//
// Pure, so the rules stay unit-testable; BufferList supplies the stores.

export interface ActivePlace {
  // null for the system buffer, which belongs to no network.
  networkId: number | null;
  // Shown under FRIENDS / FAVORITES, not under its network.
  favorite: boolean;
}

// Accordion mode: the network to show open after the active buffer changed. A
// favorite or the system buffer is not "in" any network group, so the last one stays open:
// stepping through favorites on three networks must not flap the list below.
export function nextOpenNetwork(prev: number | null, active: ActivePlace | null): number | null {
  if (!active || active.networkId == null || active.favorite) return prev;
  return active.networkId;
}

// Whether a network lists all its channels right now.
export function isNetworkOpen(net: {
  id: number;
  // Folded by hand.
  collapsed: boolean;
  // Accordion mode is on.
  accordion: boolean;
  // nextOpenNetwork's answer.
  openNetworkId: number | null;
}): boolean {
  // Accordion mode decides alone: the hand flag has no control there to undo
  // it with, so it must not hold the network you are in shut.
  if (net.accordion) return net.openNetworkId === net.id;
  return !net.collapsed;
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
