// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import type { Alias } from '../../shared/aliases.js';

// Command aliases (#276). Names arrive already normalized (lower case, no
// slash) from aliasesService, so the primary key is the lookup.

export function listAliases(userId: number): Alias[] {
  return db
    .prepare('SELECT name, body FROM user_aliases WHERE user_id = ? ORDER BY name')
    .all(userId) as Alias[];
}

export function getAlias(userId: number, name: string): Alias | null {
  const row = db
    .prepare('SELECT name, body FROM user_aliases WHERE user_id = ? AND name = ?')
    .get(userId, name) as Alias | undefined;
  return row ?? null;
}

/** Define an alias, or replace the one of that name. */
export function setAlias(userId: number, name: string, body: string): void {
  db.prepare(
    `INSERT INTO user_aliases (user_id, name, body) VALUES (?, ?, ?)
     ON CONFLICT (user_id, name)
     DO UPDATE SET body = excluded.body, updated_at = datetime('now')`,
  ).run(userId, name, body);
}

/** Give an alias a new name, a new body, or both. False when the new name is taken. */
export function updateAlias(
  userId: number,
  name: string,
  next: { name: string; body: string },
): boolean {
  // One statement, so a rename onto a taken name changes nothing at all.
  const result = db
    .prepare(
      `UPDATE OR IGNORE user_aliases
       SET name = ?, body = ?, updated_at = datetime('now')
       WHERE user_id = ? AND name = ?`,
    )
    .run(next.name, next.body, userId, name);
  return result.changes > 0;
}

export function deleteAlias(userId: number, name: string): boolean {
  const result = db
    .prepare('DELETE FROM user_aliases WHERE user_id = ? AND name = ?')
    .run(userId, name);
  return result.changes > 0;
}
