// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Folding an IRC name (a nick or a channel) the way its network does (#1425).
//
// Names are case-insensitive, and how depends on the network's CASEMAPPING:
// under rfc1459, `[]\~` are the upper case of `{}|^`, so `foo[m]` and `foo{m}`
// are one nick. A bare `toLowerCase()` misses those, and on an ascii network
// folds letters the server keeps apart. The server tells us each network's
// mapping (the snapshot, then `casemapping` frames); a network that never
// declared one folds with `toLowerCase()`, as the server does for it.
//
// Compare names with these. Don't key a map shared with the server by the
// result: its lowercase-keyed maps (peer presence, accounts, metadata) are
// built with its own rule and are looked up as it sends them.

import { foldTargetWith } from '../../../shared/casemapping.js';
import { useNetworksStore } from '../stores/networks.js';

/** `name` folded by the network's casemapping. */
export function foldName(networkId: number | string | null | undefined, name: string): string {
  // `states?.`: a store with no network state yet folds as an undeclared network.
  const mapping = networkId == null ? null : useNetworksStore().states?.[networkId]?.casemapping;
  return foldTargetWith(mapping, name);
}

/** Whether two names are the same on this network. */
export function sameName(
  networkId: number | string | null | undefined,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a === b || foldName(networkId, a) === foldName(networkId, b);
}
