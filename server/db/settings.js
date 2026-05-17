// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import db from './index.js';

export function getUserSettings(userId) {
  const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId);
  const out = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch (_) {
      // Skip malformed rows; treat as if unset.
    }
  }
  return out;
}

const upsertStmt = db.prepare(`
  INSERT INTO user_settings (user_id, key, value, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT (user_id, key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

export function setUserSetting(userId, key, value) {
  upsertStmt.run(userId, key, JSON.stringify(value));
}

export function deleteUserSetting(userId, key) {
  db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
}
