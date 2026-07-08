// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Feature flag for the dedicated admin panel (Milestone 4). When enabled, instance
// administration (users, invites, and the instance-level controls to come) moves
// out of the per-user Settings pane and into its own admin-only surface at /admin;
// when disabled — the default — nothing changes and the "Users" category stays in
// Settings exactly as before.
//
// The flag is read once from LURKER_NEW_ADMIN_PANEL and cached for the process
// lifetime, matching LURKER_EDITION. Parsing is a pure function so the truthy
// rules unit-test in isolation, and it is surfaced to the client through the
// public /api/config bootstrap the same way edition is. Follows the truthy
// grammar the DCC/bouncer flags use ('1'|'true'|'yes'|'on').

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Parse a raw LURKER_NEW_ADMIN_PANEL value into a boolean. Pure (no env access)
 * so the rules can be unit-tested directly. Unset/blank means off — the safe,
 * unchanged-behavior default for every existing deploy.
 */
export function parseNewAdminPanel(raw: string | undefined): boolean {
  return TRUTHY.has((raw ?? '').trim().toLowerCase());
}

let cached: boolean | null = null;

/** Whether the dedicated admin panel is enabled for this process (cached). */
export function isNewAdminPanelEnabled(): boolean {
  if (cached === null) cached = parseNewAdminPanel(process.env.LURKER_NEW_ADMIN_PANEL);
  return cached;
}
