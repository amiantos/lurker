// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-user feature capabilities — admin-granted gates for features that are off
// by default. Stored in the generic `user_capabilities` table (not one column
// per feature) so the forthcoming per-user admin control panel can manage every
// gate uniformly. `dcc` (the DCC download manager, #270) is the first adopter;
// add new capability keys here as features take up the pattern.

import db from './index.js';

/** The DCC download-manager capability. Gating is two-tier: the cell-wide
 *  LURKER_DCC_ENABLED master switch AND this per-user grant must both be on. */
export const CAPABILITY_DCC = 'dcc';

export interface UserCapabilityRow {
  capability: string;
  enabled: number;
  updated_at: string;
}

const getStmt = db.prepare(
  'SELECT enabled FROM user_capabilities WHERE user_id = ? AND capability = ?',
);

/** Whether `userId` has `capability` granted. An absent row means OFF —
 *  capabilities are opt-in, never default-on. */
export function userHasCapability(userId: number, capability: string): boolean {
  const row = getStmt.get(userId, capability) as { enabled: number } | undefined;
  return !!row && row.enabled === 1;
}

const upsertStmt = db.prepare(`
  INSERT INTO user_capabilities (user_id, capability, enabled, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, capability)
  DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
`);

/** Grant (enabled=true) or revoke a capability for a user. Upsert. */
export function setUserCapability(userId: number, capability: string, enabled: boolean): void {
  upsertStmt.run(userId, capability, enabled ? 1 : 0);
}

/** Every capability row for a user — the read the admin control panel will use. */
export function listUserCapabilities(userId: number): UserCapabilityRow[] {
  return db
    .prepare('SELECT capability, enabled, updated_at FROM user_capabilities WHERE user_id = ?')
    .all(userId) as UserCapabilityRow[];
}
