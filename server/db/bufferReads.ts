// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** A row from `buffer_reads`. network_id is null for the app-scoped system
 * buffer (#355). */
export interface BufferRead {
  user_id: number;
  network_id: number | null;
  target: string;
  last_read_message_id: number;
  updated_at: string;
  cleared_before_message_id: number | null;
  cleared_at: string | null;
}

export interface ClearedState {
  clearedBeforeId: number;
  clearedAt: string | null;
}

// ON CONFLICT targets the coalesced unique index (user_id, IFNULL(network_id,0),
// target) so the app-scoped system buffer (NULL network_id) dedupes — a plain
// (user_id, network_id, target) conflict target treats NULL as distinct.
const upsertStmt = db.prepare(`
  INSERT INTO buffer_reads (user_id, network_id, target, last_read_message_id, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, IFNULL(network_id, 0), target) DO UPDATE SET
    last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
    updated_at = excluded.updated_at
`);

// IFNULL on both sides so a NULL network_id (system buffer) matches its own row;
// for real network ids it's an identity, so network-buffer lookups are unchanged.
const getOneStmt = db.prepare(`
  SELECT last_read_message_id AS lastReadId
  FROM buffer_reads
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target = ?
`);

const listForUserStmt = db.prepare(`
  SELECT network_id AS networkId, target, last_read_message_id AS lastReadId
  FROM buffer_reads
  WHERE user_id = ?
`);

// Returns map keyed by `${networkId}::${target}` → lastReadId.
export function listReadStateForUser(userId: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of listForUserStmt.all(userId) as Array<{
    networkId: number;
    target: string;
    lastReadId: number;
  }>) {
    out[`${row.networkId}::${row.target}`] = row.lastReadId;
  }
  return out;
}

export function getReadState(userId: number, networkId: number | null, target: string): number {
  const row = getOneStmt.get(userId, networkId, target) as { lastReadId: number } | undefined;
  return row ? row.lastReadId : 0;
}

// Clamps to MAX(existing, requested) via the ON CONFLICT clause. Returns the
// resulting lastReadId so the caller can broadcast a value the server agrees
// with rather than echoing what the client sent.
export function setReadState(
  userId: number,
  networkId: number | null,
  target: string,
  messageId: number,
): number {
  const id = Number(messageId);
  if (!Number.isFinite(id) || id <= 0) return getReadState(userId, networkId, target);
  upsertStmt.run(userId, networkId, target, id);
  return getReadState(userId, networkId, target);
}

// --- /clear marker state ---------------------------------------------------
//
// The clear marker lives on the same buffer_reads row as the read pointer
// (one row per user/buffer is enough), but it's controlled separately:
// /clear writes only the cleared_* columns and never touches the read
// pointer — hiding a message doesn't mark it read.

const upsertClearedStmt = db.prepare(`
  INSERT INTO buffer_reads
    (user_id, network_id, target, last_read_message_id,
     cleared_before_message_id, cleared_at, updated_at)
  VALUES (?, ?, ?, 0, ?, ?, datetime('now'))
  ON CONFLICT(user_id, IFNULL(network_id, 0), target) DO UPDATE SET
    cleared_before_message_id = excluded.cleared_before_message_id,
    cleared_at = excluded.cleared_at,
    updated_at = excluded.updated_at
`);

const getClearedStmt = db.prepare(`
  SELECT
    cleared_before_message_id AS clearedBeforeId,
    cleared_at AS clearedAt
  FROM buffer_reads
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target = ?
`);

const listClearedStmt = db.prepare(`
  SELECT network_id AS networkId, target,
         cleared_before_message_id AS clearedBeforeId,
         cleared_at AS clearedAt
  FROM buffer_reads
  WHERE user_id = ?
    AND cleared_before_message_id IS NOT NULL
    AND cleared_before_message_id > 0
`);

export function getClearedState(userId: number, networkId: number, target: string): ClearedState {
  const row = getClearedStmt.get(userId, networkId, target) as
    | { clearedBeforeId: number | null; clearedAt: string | null }
    | undefined;
  if (!row || !row.clearedBeforeId) return { clearedBeforeId: 0, clearedAt: null };
  return { clearedBeforeId: row.clearedBeforeId, clearedAt: row.clearedAt };
}

// boundaryId === 0 (or null) clears the marker — equivalent to "Show earlier
// messages" / `/clear off`. Otherwise the boundary id is the largest id the
// user wants hidden; clearedAt is shown in the divider above the first
// surviving row.
export function setClearedState(
  userId: number,
  networkId: number,
  target: string,
  boundaryId: number,
  clearedAt: string | null,
): ClearedState {
  const id = Number(boundaryId);
  if (!Number.isFinite(id) || id <= 0) {
    upsertClearedStmt.run(userId, networkId, target, null, null);
    return { clearedBeforeId: 0, clearedAt: null };
  }
  upsertClearedStmt.run(userId, networkId, target, id, clearedAt);
  return getClearedState(userId, networkId, target);
}

// Map keyed by `${networkId}::${target}` for buffers with an active clear
// marker. Sparse — buffers that have never been cleared aren't returned, so
// callers default to the no-clear state for missing keys.
export function listClearedStateForUser(userId: number): Record<string, ClearedState> {
  const out: Record<string, ClearedState> = {};
  for (const row of listClearedStmt.all(userId) as Array<{
    networkId: number;
    target: string;
    clearedBeforeId: number;
    clearedAt: string | null;
  }>) {
    out[`${row.networkId}::${row.target}`] = {
      clearedBeforeId: row.clearedBeforeId,
      clearedAt: row.clearedAt,
    };
  }
  return out;
}
