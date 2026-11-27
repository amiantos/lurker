// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Accordion mode for the sidebar (#1432, `look.buffer_list.accordion`): only
// the network you are in lists its channels; every other network is its header
// row. Nothing is stored and nothing is toggled by hand. Which network is open
// follows the active buffer, so every way of getting somewhere (a click,
// Alt+arrow, the quick switcher, a notification) opens the network it lands in
// and closes the one it left, and keyboard order is untouched.
//
// Pure, so the two rules stay unit-testable; BufferList supplies the stores.

export interface ActivePlace {
  // null for the system buffer, which belongs to no network.
  networkId: number | null;
  // Shown under FRIENDS / FAVORITES, not under its network.
  favorite: boolean;
}

// The network to show open after the active buffer changed. A favorite or the
// system buffer is not "in" any network group, so the last one stays open:
// stepping through favorites on three networks must not flap the list below.
export function nextOpenNetwork(prev: number | null, active: ActivePlace | null): number | null {
  if (!active || active.networkId == null || active.favorite) return prev;
  return active.networkId;
}

export interface ClosedNetworkView<T> {
  // Still listed under the closed header: buffers with a highlight (a DM's
  // unread lines are all highlights), in sidebar order. One click away.
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
  rules: { count: (buf: T) => number; countsAsUnread: (buf: T) => boolean },
): ClosedNetworkView<T> {
  const rows: T[] = [];
  let hiddenCount = 0;
  let hiddenUnread = false;
  for (const buf of bufs) {
    if (buf.highlighted > 0) {
      rows.push(buf);
      continue;
    }
    hiddenCount += rules.count(buf);
    if (rules.countsAsUnread(buf)) hiddenUnread = true;
  }
  return { rows, hiddenCount, hiddenUnread };
}
