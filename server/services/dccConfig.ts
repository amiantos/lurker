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
import { effectiveSetting } from './settingsService.js';
import { allowlistMatches } from './hostmaskMatch.js';

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
// Per-user DCC preferences (settings registry). These only ever tighten or
// automate — never widen — the operator's env-level gates: auto-accept is
// scoped to an allowlist, the per-user size cap stacks under the env cap, and
// prefer-passive just reorders the offer strategy. All read live.
// ---------------------------------------------------------------------------

/** Whether inbound SENDs from allow-listed nicks are accepted automatically
 *  (dcc.auto_accept). Off by default — an unsolicited file must be a deliberate
 *  opt-in. Only meaningful together with dccAutoAcceptList. */
export function dccAutoAccept(userId: number): boolean {
  return effectiveSetting(userId, 'dcc.auto_accept') === true;
}

/** The nick / hostmask globs auto-accept applies to (dcc.auto_accept_from). */
export function dccAutoAcceptList(userId: number): string[] {
  const v = effectiveSetting(userId, 'dcc.auto_accept_from');
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

/** Whether an inbound SEND from `nick` (`hostmask` = nick!user@host) should be
 *  auto-accepted: the toggle is on AND the sender matches the allowlist. An empty
 *  allowlist never matches, so auto-accept is inert until the user names someone. */
export function dccShouldAutoAccept(userId: number, nick: string, hostmask: string): boolean {
  if (!dccAutoAccept(userId)) return false;
  const list = dccAutoAcceptList(userId);
  return list.length > 0 && allowlistMatches(list, hostmask, nick);
}

/** Whether to offer outgoing SENDs as passive/reverse first (dcc.prefer_passive)
 *  — more reliable when the user is behind NAT / attached via the bouncer, where
 *  an active listener isn't reachable. Off by default (active-listen first). */
export function dccPreferPassive(userId: number): boolean {
  return effectiveSetting(userId, 'dcc.prefer_passive') === true;
}

/** Per-user cap on an accepted inbound file, in bytes (dcc.max_accept_mb); 0 =
 *  no per-user cap. The effective cap is the smaller of this and the env cap. */
export function dccMaxAcceptBytes(userId: number): number {
  const v = effectiveSetting(userId, 'dcc.max_accept_mb');
  const mb = typeof v === 'number' && v > 0 ? Math.floor(v) : 0;
  return mb > 0 ? mb * 1024 * 1024 : 0;
}

/** The effective inbound size cap for `userId`: the tighter of the operator env
 *  cap and the user's own cap (0 on either side meaning "no cap on that side").
 *  Returns 0 when neither caps. */
export function dccEffectiveAcceptCap(userId: number): number {
  const env = dccMaxFileBytes();
  const user = dccMaxAcceptBytes(userId);
  const caps = [env, user].filter((n) => n > 0);
  return caps.length ? Math.min(...caps) : 0;
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
