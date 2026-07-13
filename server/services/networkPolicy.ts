// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The instance network lockdown (#298), in one predicate.
//
// This mirrors listAllowedUploaders' role in the uploader system: a single
// source of truth that every surface consults, so the picker can never offer
// something the connect path would then refuse.
//
// It differs from the uploader lockdown in one deliberate way. Flipping the
// uploader switch off blocks only NEW personal uploaders — the ones people
// already have keep working ("don't strand a self-hoster who flips the switch").
// Copying that verbatim here would leave the toggle useless: anyone who added
// Libera before lockdown would keep chatting on Libera, so a "closed" instance
// wouldn't actually be closed. So for networks the gate also sits on the connect
// path, and an off-list network a user already owns simply stops connecting.
//
// Nothing is deleted. The row, its channels and its history all survive, and
// re-enabling the switch (or adding the host as a preset) brings it straight
// back. Destroying a user's networks — and, via ON DELETE CASCADE, their message
// history — as a side effect of ticking an admin checkbox would be a wildly
// disproportionate response to a policy change.

import { allowUserDefinedNetworks } from '../db/instanceSettings.js';
import { listEnabledInstanceNetworks } from '../db/instanceNetworks.js';

// Hosts are compared case-insensitively (DNS is), and on host ALONE — not
// host:port. The meaningful boundary is *which server you are talking to*; an
// admin who allows irc.corp.example has allowed that operator's machine, and
// whether the user reaches it on 6697 or 6667 isn't the thing being policed.
// Matching the port too would just mean a lockdown that silently fails whenever
// someone picks the plaintext port.
export function isNetworkHostAllowed(host: string): boolean {
  return hostAllowedChecker()(host);
}

// The same predicate with the policy resolved ONCE, for callers testing several
// hosts in a row (GET /api/networks maps it over every row). The policy is
// instance-global, so re-reading instance_settings — and re-listing and
// re-JSON-parsing every preset — per network is pure waste.
//
// Deliberately a per-call snapshot rather than a cached module-level value: an
// admin flipping the switch has to take effect on the very next request, and a
// stale cache here would mean a lockdown that doesn't lock down.
export function hostAllowedChecker(): (host: string) => boolean {
  if (allowUserDefinedNetworks()) return () => true;
  const allowed = new Set(listEnabledInstanceNetworks().map((p) => p.host.toLowerCase()));
  return (host: string) => {
    const target = (host || '').trim().toLowerCase();
    if (!target) return false;
    return allowed.has(target);
  };
}
