// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which hosts a user may connect to, in one predicate. Two tiers, and a host
// has to clear both:
//
//   the instance lockdown (#298) — the admin's list, applied to everyone; and
//   the account's own restrictions (shared/accountRestrictions.ts) — a list the
//   admin or the control plane pinned to ONE account, applied under it.
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
// disproportionate response to a policy change. The same holds for an account
// restriction: lifting it brings every network back as it was.

import { allowUserDefinedNetworks } from '../db/instanceSettings.js';
import { listEnabledInstanceNetworks } from '../db/instanceNetworks.js';
import { findUserById, restrictionsOf } from '../db/users.js';
import { foldHost } from '../../shared/accountRestrictions.js';

// Why a host was refused, so a route can say so. The two messages are kept
// distinct on purpose: "ask your admin to list it" and "this account can't" are
// different next steps for the person reading them.
export const INSTANCE_REFUSAL = 'this server only allows the networks its admin has listed';
export const ACCOUNT_REFUSAL = 'this account is limited to the networks it has been allowed';
export const PROXY_REFUSAL = 'this account may not connect through a proxy of its own';

// Hosts are compared case-insensitively (DNS is), and on host ALONE — not
// host:port. The meaningful boundary is *which server you are talking to*; an
// admin who allows irc.corp.example has allowed that operator's machine, and
// whether the user reaches it on 6697 or 6667 isn't the thing being policed.
// Matching the port too would just mean a lockdown that silently fails whenever
// someone picks the plaintext port.
//
// `userId` is optional only for the instance-wide question ("would ANY account
// be allowed this host?"); every per-request caller passes the account.
export function isNetworkHostAllowed(host: string, userId?: number): boolean {
  return hostAllowedChecker(userId)(host);
}

// May a user route a network through a proxy of their own choosing? (#303)
//
// Tied to the same switch rather than given one of its own, because on a
// LOCKED-DOWN instance a user-supplied proxy is an escape from exactly what the
// lockdown closes: an arbitrary outbound TCP connection to an address the admin
// never approved, carrying bytes the user chose. The ircd is still gated by
// isNetworkHostAllowed, but the PROXY is a second destination, and nothing else
// checks it. An account held to a list of hosts is locked down in the same
// sense, so the same escape is closed for it.
//
// On an unlocked instance it grants nothing new — you can already point `host`
// anywhere — which is why this needs no separate setting, and why the default
// (open) leaves self-hosters and hosted customers exactly as they were.
//
// ⚠ Enforced on write AND re-checked on the connect path, the same shape
// isNetworkHostAllowed has: a gate only on write is a formality once an admin
// can flip the switch after the fact.
export function mayUseProxy(userId?: number): boolean {
  if (!allowUserDefinedNetworks()) return false;
  return userId == null || restrictionsOf(findUserById(userId)).networks === null;
}

// The same predicate with the policy resolved ONCE, for callers testing several
// hosts in a row (GET /api/networks maps it over every row). Re-reading
// instance_settings — and re-listing and re-JSON-parsing every preset — per
// network is pure waste.
//
// Deliberately a per-call snapshot rather than a cached module-level value: an
// admin flipping the switch has to take effect on the very next request, and a
// stale cache here would mean a lockdown that doesn't lock down.
export function hostAllowedChecker(userId?: number): (host: string) => boolean {
  const instance = instanceChecker();
  const own = ownHosts(userId);
  if (own === null) return instance;
  return (host: string) => instance(host) && own.has(foldHost(host || ''));
}

// The reason a host is refused for this account, or null when it is allowed.
// The instance's answer comes first: a host the admin never listed is refused
// for everyone, and telling the account it is the one being limited would send
// the person to the wrong door. Each tier is resolved once: this runs on every
// connect, including the boot-time autoconnect fan-out.
export function networkRefusal(host: string, userId: number): string | null {
  if (!instanceChecker()(host)) return INSTANCE_REFUSAL;
  const own = ownHosts(userId);
  if (own !== null && !own.has(foldHost(host || ''))) return ACCOUNT_REFUSAL;
  return null;
}

// The account's own host list as a set, or null when it has none.
function ownHosts(userId?: number): Set<string> | null {
  if (userId == null) return null;
  const own = restrictionsOf(findUserById(userId)).networks;
  return own === null ? null : new Set(own);
}

function instanceChecker(): (host: string) => boolean {
  if (allowUserDefinedNetworks()) return () => true;
  const allowed = new Set(listEnabledInstanceNetworks().map((p) => p.host.toLowerCase()));
  return (host: string) => {
    const target = foldHost(host || '');
    if (!target) return false;
    return allowed.has(target);
  };
}
