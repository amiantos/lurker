// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Tiered "smart sort" for the quick switcher (#393), applied AFTER the user's
// query narrows the list (matchSwitcherRows, below — a query yields two groups,
// each sorted on its own): recent → pinned → unread → alphabetical. A switcher's
// job is fast movement, so recency leads (the way VS Code's Ctrl+Tab / Cmd+P,
// Slack's Cmd+K, and browser address bars all rank) — not pins. Buffers visited
// this session sort by recency at the top; pins you *haven't* touched this
// session form a "favourites" shelf below that; then unread; then the rest
// alphabetically. Each buffer lands in exactly the highest tier it qualifies
// for. Pure (no Vue/store deps) so the tier precedence and tie-breaks stay
// unit-testable; the component supplies recency (from stores/recentBuffers) and
// pin state, and decides whether the active buffer is in the list at all (it
// is only when a query finds it by name).

export interface SwitcherItem {
  // `${networkId}::${target}` — both the row identity and the recency lookup key.
  key: string;
  pinned: boolean;
  unread: number;
  // Pre-normalised label for the alphabetical tie-break (leading '#' stripped,
  // lowercased) — see bufferSortKey.
  sortKey: string;
}

export interface SmartSortOptions {
  // recencyRank(key): 0 = most recent … Infinity = unvisited this session.
  recencyRank: (key: string) => number;
}

const TIER_RECENT = 0;
const TIER_PINNED = 1;
const TIER_UNREAD = 2;
const TIER_ALPHA = 3;

export function smartSortRows<T extends SwitcherItem>(rows: T[], opts: SmartSortOptions): T[] {
  const { recencyRank } = opts;

  const tierOf = (r: T): number => {
    if (recencyRank(r.key) !== Infinity) return TIER_RECENT;
    if (r.pinned) return TIER_PINNED;
    if (r.unread > 0) return TIER_UNREAD;
    return TIER_ALPHA;
  };

  return rows.toSorted((a, b) => {
    const ta = tierOf(a);
    const tb = tierOf(b);
    if (ta !== tb) return ta - tb;
    // Recent tier: most-recently-visited first (both ranks finite here).
    if (ta === TIER_RECENT) return recencyRank(a.key) - recencyRank(b.key);
    // Unread tier: most unread first, then alphabetical.
    if (ta === TIER_UNREAD && a.unread !== b.unread) return b.unread - a.unread;
    // Pinned and alphabetical tiers (and unread ties) fall back to alphabetical.
    return a.sortKey.localeCompare(b.sortKey);
  });
}

export interface SwitcherMatchable {
  // What the row shows: the channel / DM name, or '[server]'.
  label: string;
  networkName: string;
}

// Narrow the switcher's rows to a typed query (#1465). The query splits on
// whitespace and every word must appear in the row's name or its network's
// name, so "lib" lists everything on Libera and "lib sen" picks #senpai there.
// `q` arrives trimmed and lowercased.
//
// Returns two groups rather than one list: a row every word finds by name
// alone is a name match, the rest needed the network to get in. The caller
// sorts each and shows name matches first, so a network that happens to share
// a word with a channel never buries the channel you typed.
export function matchSwitcherRows<T extends SwitcherMatchable>(
  rows: T[],
  q: string,
): { byName: T[]; byNetwork: T[] } {
  const words = q.split(/\s+/).filter(Boolean);
  const byName: T[] = [];
  const byNetwork: T[] = [];
  for (const r of rows) {
    const label = r.label.toLowerCase();
    if (words.every((w) => label.includes(w))) {
      byName.push(r);
      continue;
    }
    const net = r.networkName.toLowerCase();
    if (words.every((w) => label.includes(w) || net.includes(w))) byNetwork.push(r);
  }
  return { byName, byNetwork };
}
