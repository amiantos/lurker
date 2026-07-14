// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Curated "pick a network" catalogue for the add-network flow (#169). The raw
// data is hand-maintained in builtinNetworks.json (seeded from the netsplit.de
// top-100 + MansionNET, connection details verified per network). This module
// just types it and derives the tag facet list for the picker's filter chips.

import data from './builtinNetworks.json';

export interface BuiltinNetwork {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  website: string;
  /** Approximate concurrent users (netsplit snapshot), for sort/popularity. null if unknown. */
  users: number | null;
  /** Approximate channel count (netsplit snapshot). null if unknown. */
  channels: number | null;
  /**
   * The network's main general-chat channel, where we can name one the network
   * itself documents (#308). Absent is the honest default and by far the common
   * case: a wrong name lands a brand-new user in a channel that doesn't exist,
   * which is worse than landing them nowhere. Filling these in for the long tail
   * is a standing invitation to people who actually use those networks.
   *
   * Note this is deliberately singular. It is *the network's* channel, not a
   * starter list — the onboarding flow builds its list by combining this with
   * #lurker (see LURKER_TAG), and keeping the data one string per network keeps
   * a community PR down to one line.
   */
  defaultChannel?: string;
  /** True when a client on a cloud/datacenter IP likely needs SASL to connect (e.g. Libera). */
  saslLikelyRequired: boolean;
  tags: string[];
}

/**
 * What the picker actually renders: a bundled builtin, or a network the
 * instance's admin defined (#298). The two are deliberately the same shape so
 * the picker merges them into one list instead of branching per row.
 */
export interface NetworkPreset extends BuiltinNetwork {
  /**
   * The admin's recommended channels for an instance preset — pre-checked in the
   * first-run flow. Plural, unlike a builtin's single `defaultChannel`: an admin
   * knows their own network and can reasonably say "join #general and #random",
   * whereas for a public network we only ever claim to know its one main channel.
   */
  recommendedChannels?: string[];
  /** True for an admin-defined preset. They pin above the builtins and get a badge. */
  isInstance?: boolean;
  /**
   * The instance_network row id, on instance presets only. Carried purely so the
   * picker has a stable, genuinely unique v-for key: nothing enforces host (or
   * name) uniqueness on that table, and an admin may reasonably list the same
   * server twice — two ports, or a TLS and a plaintext entry.
   */
  instanceId?: number;
}

// Sorted most-popular-first so the picker's default order is meaningful; entries
// without a user count sink to the bottom but keep their relative input order.
// Networks carrying this tag have an active #lurker channel. The picker floats
// them to the top, badges them ("#lurker available"), and defaults their join
// channel to #lurker. It's a marker, not a browse category, so it's kept out of
// the filter facets and the card's tag list.
export const LURKER_TAG = 'lurker';

// Lurker-friendly networks first, then most-popular-first within each group.
export const builtinNetworks: BuiltinNetwork[] = (data as BuiltinNetwork[]).toSorted((a, b) => {
  const lurkerDelta = Number(b.tags.includes(LURKER_TAG)) - Number(a.tags.includes(LURKER_TAG));
  if (lurkerDelta !== 0) return lurkerDelta;
  return (b.users ?? -1) - (a.users ?? -1);
});

export const LURKER_CHANNEL = '#lurker';

// Where we know nothing about a network, "#chat" is the guess we fall back to
// (#169's "always land the user in a channel rather than an empty server
// buffer"). It stays a *guess*, so the two callers treat it differently: the
// add-network form prefills it into an editable field a user reviews before
// connecting, while the first-run flow only ever offers it as a placeholder —
// it will not one-click-join a brand-new user into a channel we invented.
export const FALLBACK_CHANNEL = '#chat';

// The channels we can actually stand behind for a network.
//
// For an admin-defined instance preset that's simply whatever the admin listed —
// they run the place, so their word is the last word, and we don't second-guess
// it with #lurker.
//
// For a builtin it's the network's own documented main channel (#308) plus
// #lurker where there's an active one. Order matters: #lurker leads, because a
// new user is better served by the room where they can get help with the client
// than by the network's general chat.
export function suggestedChannels(net: NetworkPreset): string[] {
  if (net.isInstance) return [...(net.recommendedChannels ?? [])];
  const out: string[] = [];
  if (net.tags.includes(LURKER_TAG)) out.push(LURKER_CHANNEL);
  const own = net.defaultChannel;
  if (own && !out.some((c) => c.toLowerCase() === own.toLowerCase())) out.push(own);
  return out;
}

// Distinct browse tags, alphabetised — the picker renders these as filter chips.
// Derived rather than hardcoded so editing the JSON is enough; LURKER_TAG is
// excluded (it's shown as a badge, not offered as a filter category).
export const builtinNetworkTags: string[] = [...new Set(builtinNetworks.flatMap((n) => n.tags))]
  .filter((t) => t !== LURKER_TAG)
  .toSorted();
