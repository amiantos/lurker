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
