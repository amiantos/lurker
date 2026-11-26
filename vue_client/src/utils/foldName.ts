// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Folding an IRC name (a nick or a channel) the way its network does (#1425).
//
// Names are case-insensitive, and how depends on the network's CASEMAPPING:
// under rfc1459, `[ \ ] ^` are the upper case of `{ | } ~`, so `foo[m]` and
// `foo{m}` are one nick. A bare `toLowerCase()` misses those, and on an ascii network
// folds letters the server keeps apart. The server tells us each network's
// mapping (the snapshot, then `casemapping` frames); a network that never
// declared one folds with `toLowerCase()`, as the server does for it.
//
// Compare names with these. Don't key a map shared with the server by the
// result: its lowercase-keyed maps (peer presence, accounts, metadata) are
// built with its own rule and are looked up as it sends them.

import { foldTargetWith, type Casemapping } from '../../../shared/casemapping.js';
import { useNetworksStore } from '../stores/networks.js';

// Folded spellings already worked out, per mapping. The same few hundred nicks
// are folded over and over (a speaker lookup scans the member list for every
// rendered row), and the bound-based folds build their result a character at a
// time. Emptied when it grows past a size no one channel reaches.
const MEMO_MAX = 20_000;
const memos = new Map<Casemapping | null, Map<string, string>>();

function folderWith(mapping: Casemapping | null): (name: string) => string {
  let memo = memos.get(mapping);
  if (!memo) memos.set(mapping, (memo = new Map()));
  const cache = memo;
  return (name) => {
    let folded = cache.get(name);
    if (folded === undefined) {
      if (cache.size >= MEMO_MAX) cache.clear();
      cache.set(name, (folded = foldTargetWith(mapping, name)));
    }
    return folded;
  };
}

/**
 * The network's fold as a function, for a loop: the store is read once here,
 * not once per name. Read it inside a computed or a render so a `casemapping`
 * frame still re-runs the caller.
 */
export function folderFor(networkId: number | string | null | undefined): (name: string) => string {
  // `states?.`: a store with no network state yet folds as an undeclared network.
  const mapping = networkId == null ? null : useNetworksStore().states?.[networkId]?.casemapping;
  return folderWith(mapping ?? null);
}

/** `name` folded by the network's casemapping. */
export function foldName(networkId: number | string | null | undefined, name: string): string {
  return folderFor(networkId)(name);
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
