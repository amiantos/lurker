// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Sidebar order across all networks. Mirrors the visual layout in BufferList:
// per network, the server pseudo-buffer first, then pinned buffers in their
// stored order, then unpinned buffers (channels alphabetically before DMs
// alphabetically). Used by keyboard navigation so prev/next-channel and the
// quick switcher walk the same order the user sees in the sidebar.

interface BufferEntry {
  target: string;
}

interface Network {
  id: string | number;
}

interface PinsStore {
  forNetwork(networkId: string | number): string[] | null | undefined;
}

interface BuffersStore {
  forNetwork(networkId: string | number): BufferEntry[];
  byKey(key: string): { unread: number } | null | undefined;
}

// The FRIENDS pseudo-network (a feed header + each friend's primary DM) is
// injected at the top so keyboard nav / quick-switch walk the same order the
// sidebar renders. `excludeKeys` drops those primary DMs from their real
// network so they aren't visited twice.
interface FriendsOrder {
  dms: Array<{ networkId: string | number; target: string }>;
  excludeKeys?: Set<string>;
  feedKey?: string;
}

interface BufferOrderArgs {
  networks: Network[];
  buffers: BuffersStore;
  pins: PinsStore;
  friends?: FriendsOrder;
}

// Sentinel nav-group id for the FRIENDS group — its members carry their real
// networkId for activation but nav-group together, apart from that network. A
// non-numeric string so it can never alias a real network id (which are
// positive integers), even though groupId shares the `string | number` space.
export const FRIENDS_GROUP_ID = 'group:friends';

interface BufferOrderEntry {
  networkId: string | number;
  target: string;
  // The activeKey for this entry — `${networkId}::${target}` for real buffers,
  // a flat sentinel (e.g. ':friends:') for virtual ones. Callers match the
  // active buffer and re-activate against this rather than recomputing.
  key: string;
  // Navigation group for per-network (Alt+Up/Down) scoping. Equals networkId
  // for real buffers; FRIENDS_GROUP_ID for the feed + friend DMs, so cycling a
  // network never wanders into the FRIENDS group and vice-versa.
  groupId: string | number;
}

function isServerTarget(target: string): boolean {
  return typeof target === 'string' && target.startsWith(':server:');
}

function isChannelTarget(target: string): boolean {
  return typeof target === 'string' && target.startsWith('#');
}

function sortKey(target: string): string {
  return target.replace(/^#+/, '').toLowerCase();
}

function bufferOrder(target: string): number {
  return isChannelTarget(target) ? 0 : 1;
}

// Returns a flat array of { networkId, target, key } entries in sidebar order.
export function flattenBufferOrder({
  networks,
  buffers,
  pins,
  friends,
}: BufferOrderArgs): BufferOrderEntry[] {
  const out: BufferOrderEntry[] = [];
  const exclude = friends?.excludeKeys;
  const isExcluded = (networkId: string | number, target: string): boolean =>
    !!exclude && exclude.has(`${networkId}::${target.toLowerCase()}`);

  // FRIENDS group first (matches the sidebar): feed header, then friend DMs.
  // All carry FRIENDS_GROUP_ID so per-network nav treats them as one group.
  if (friends?.feedKey) {
    out.push({
      networkId: FRIENDS_GROUP_ID,
      target: friends.feedKey,
      key: friends.feedKey,
      groupId: FRIENDS_GROUP_ID,
    });
  }
  for (const dm of friends?.dms || []) {
    out.push({
      networkId: dm.networkId,
      target: dm.target,
      key: `${dm.networkId}::${dm.target}`,
      groupId: FRIENDS_GROUP_ID,
    });
  }

  for (const net of networks) {
    const serverTarget = `:server:${net.id}`;
    out.push({
      networkId: net.id,
      target: serverTarget,
      key: `${net.id}::${serverTarget}`,
      groupId: net.id,
    });

    const pinnedTargets = pins.forNetwork(net.id) || [];
    const pinnedSet = new Set(pinnedTargets);
    const all = buffers.forNetwork(net.id);
    const byTarget = new Map<string, BufferEntry>();
    for (const b of all) byTarget.set(b.target, b);

    for (const t of pinnedTargets) {
      if (byTarget.has(t) && !isExcluded(net.id, t))
        out.push({ networkId: net.id, target: t, key: `${net.id}::${t}`, groupId: net.id });
    }

    const unpinned = all
      .filter(
        (b) =>
          !isServerTarget(b.target) && !pinnedSet.has(b.target) && !isExcluded(net.id, b.target),
      )
      .toSorted((a, b) => {
        const oa = bufferOrder(a.target);
        const ob = bufferOrder(b.target);
        if (oa !== ob) return oa - ob;
        return sortKey(a.target).localeCompare(sortKey(b.target));
      });
    for (const b of unpinned)
      out.push({
        networkId: net.id,
        target: b.target,
        key: `${net.id}::${b.target}`,
        groupId: net.id,
      });
  }
  return out;
}

// Same shape as flattenBufferOrder but only entries with unread > 0. Server
// pseudo-buffers participate (network-level notices land there); the virtual
// FRIENDS feed never has unread, so it drops out here naturally.
export function flattenUnreadOrder(args: BufferOrderArgs): BufferOrderEntry[] {
  const { buffers } = args;
  return flattenBufferOrder(args).filter((entry) => {
    const buf = buffers.byKey(entry.key);
    return !!buf && buf.unread > 0;
  });
}
