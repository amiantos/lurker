// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import db from './index.js';

const upsertStmt = db.prepare(`
  INSERT INTO user_drafts (user_id, network_id, target, body, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT (user_id, network_id, target) DO UPDATE SET
    body = excluded.body,
    updated_at = excluded.updated_at
`);

const clearStmt = db.prepare(`
  DELETE FROM user_drafts
   WHERE user_id = ? AND network_id = ? AND target = ?
`);

const listStmt = db.prepare(`
  SELECT network_id AS networkId, target, body, updated_at AS updatedAt
    FROM user_drafts
   WHERE user_id = ?
`);

export function upsertDraft(userId, networkId, target, body) {
  upsertStmt.run(userId, networkId, target, body);
}

export function clearDraft(userId, networkId, target) {
  clearStmt.run(userId, networkId, target);
}

// Returns every draft for this user as plain objects — the snapshot ships
// across the wire on connect (and on a tab-visibility resync).
export function listForUser(userId) {
  return listStmt.all(userId);
}
