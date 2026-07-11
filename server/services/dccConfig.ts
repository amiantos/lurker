// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC enablement gate (#270). DCC is OFF by default and gated in two tiers:
//   1. a cell-wide master switch, LURKER_DCC_ENABLED — the operator opt-in. It
//      stays unset (off) on hosted lurker.chat cells, so the feature is dark
//      there for now; a self-hoster sets it to turn DCC on for the instance.
//   2. a per-user capability grant (CAPABILITY_DCC) — so even with the master
//      switch on, an account only gets DCC if an admin granted it. This is the
//      first consumer of the per-user capability store the admin control panel
//      will manage.
// BOTH must be true for a user to use DCC. The master-switch parser is pure (and
// unit-tested); the per-user gate reads the DB.

import { CAPABILITY_DCC, userHasCapability } from '../db/userCapabilities.js';

// Conventional truthy env values — trimmed + case-insensitive.
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Parse a raw LURKER_DCC_ENABLED value to a boolean. Pure (no env access) so
 *  the rule is unit-testable. Unset / empty / anything-else is OFF — DCC must be
 *  an explicit opt-in, never accidentally on. */
export function parseDccEnabled(raw: string | undefined): boolean {
  return TRUTHY.has((raw ?? '').trim().toLowerCase());
}

/** The cell-wide DCC master switch. Read live (not cached) so an operator flip
 *  — and tests — take effect without a process restart. */
export function dccMasterEnabled(): boolean {
  return parseDccEnabled(process.env.LURKER_DCC_ENABLED);
}

/** Whether `userId` may use DCC: the master switch AND a per-user grant. The
 *  single gate every DCC entry point (CTCP wiring, API, commands) checks. */
export function dccEnabledForUser(userId: number): boolean {
  return dccMasterEnabled() && userHasCapability(userId, CAPABILITY_DCC);
}

/** Operator cap on a single accepted DCC file, in bytes, from
 *  LURKER_DCC_MAX_FILE_MB. 0 (unset / non-positive / unparseable) means no cap. */
export function dccMaxFileBytes(): number {
  const mb = Number((process.env.LURKER_DCC_MAX_FILE_MB ?? '').trim());
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb) * 1024 * 1024 : 0;
}

/** Whether to allow dialing private/loopback/reserved DCC hosts
 *  (LURKER_DCC_ALLOW_PRIVATE_HOSTS). OFF by default — the SSRF guard blocks them;
 *  a self-hoster pulling from a bot on their own LAN can opt in. */
export function dccAllowPrivateHosts(): boolean {
  return parseDccEnabled(process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS);
}

// ---------------------------------------------------------------------------
// Outbound-side config: DCC SEND / CHAT offers and passive receive need Lurker
// to LISTEN for an inbound connection and advertise a reachable address back to
// the peer. All of this is only consulted when the user offers a send/chat or
// accepts a passive send — plain XDCC downloads (dial-out) never touch it.
// ---------------------------------------------------------------------------

/** The public host to advertise in outgoing DCC offers (LURKER_DCC_EXTERNAL_HOST)
 *  — the address a peer on the internet connects back to, i.e. the host's public
 *  IPv4 (or a hostname that resolves to it), NOT the container's private IP. An
 *  IPv6 literal is allowed too. Unset means active/listening DCC can't advertise
 *  a usable address, so the offer path falls back to passive/reverse where the
 *  peer listens instead. Returns the trimmed value or null. */
export function dccExternalHost(): string | null {
  const h = (process.env.LURKER_DCC_EXTERNAL_HOST ?? '').trim();
  return h || null;
}

/** Bind address for DCC listening sockets inside the container
 *  (LURKER_DCC_LISTEN_BIND). Defaults to 0.0.0.0 so a Docker port-publish reaches
 *  it; pin it to one interface if you run multi-homed. */
export function dccListenBindHost(): string {
  const h = (process.env.LURKER_DCC_LISTEN_BIND ?? '').trim();
  return h || '0.0.0.0';
}

/** The inclusive TCP port range DCC listeners are allocated from
 *  (LURKER_DCC_LISTEN_PORT_MIN / _MAX). This exact range must be reachable from
 *  the internet — opened in the firewall AND published by Docker. Returns null
 *  when unset or invalid, which disables active listening (passive-only). The
 *  range size also caps how many concurrent offers can be outstanding. */
export function dccListenPortRange(): { min: number; max: number } | null {
  const min = Number((process.env.LURKER_DCC_LISTEN_PORT_MIN ?? '').trim());
  const max = Number((process.env.LURKER_DCC_LISTEN_PORT_MAX ?? '').trim());
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (min < 1 || max > 65535 || min > max) return null;
  return { min, max };
}

/** Whether Lurker can open active (listening) DCC — needs both a public host to
 *  advertise and a port range to listen on. When false, the offer/passive paths
 *  fall back to reverse DCC (peer listens, Lurker dials out). */
export function dccActiveListenAvailable(): boolean {
  return dccExternalHost() !== null && dccListenPortRange() !== null;
}
