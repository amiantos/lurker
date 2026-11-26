// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { resolveBuffer } from './bufferResolve.js';
import { advanceUnreadCount } from './unreadCounts.js';

// buffer_reads is keyed (user_id, buffer_id) since schema 18 — the name lives
// in `buffers` alone. Exported signatures still take (networkId, target)
// because that's what callers hold; each entry point resolves the name once
// through bufferResolve. A resolution miss means "no such buffer": reads
// return the zero state, writes are a no-op — state for a buffer that doesn't
// exist is meaningless, and the old path's implicit row-for-any-string was
// exactly the detached-pointer bug class (#355's ms-blowup incident).
//
// The list functions join back through `buffers` so their wire shape —
// `${networkId}::${target}` map keys — is byte-identical to the name-keyed
// era (a NULL networkId stringifies to "null", matching the system buffer's
// old key).

export interface ClearedState {
  clearedBeforeId: number;
  clearedAt: string | null;
}

const upsertStmt = db.prepare(`
  INSERT INTO buffer_reads (user_id, buffer_id, last_read_message_id, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(user_id, buffer_id) DO UPDATE SET
    last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
    updated_at = excluded.updated_at
`);

const getOneStmt = db.prepare(`
  SELECT last_read_message_id AS lastReadId
  FROM buffer_reads
  WHERE user_id = ? AND buffer_id = ?
`);

const listForUserStmt = db.prepare(`
  SELECT b.network_id AS networkId, b.target AS target, r.last_read_message_id AS lastReadId
  FROM buffer_reads r JOIN buffers b ON b.id = r.buffer_id
  WHERE r.user_id = ?
`);

// Returns map keyed by `${networkId}::${target}` → lastReadId.
export function listReadStateForUser(userId: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of listForUserStmt.all(userId) as Array<{
    networkId: number | null;
    target: string;
    lastReadId: number;
  }>) {
    out[`${row.networkId}::${row.target}`] = row.lastReadId;
  }
  return out;
}

export function getReadState(userId: number, networkId: number | null, target: string): number {
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return 0;
  const row = getOneStmt.get(userId, buffer.id) as { lastReadId: number } | undefined;
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
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return 0;
  const id = Number(messageId);
  if (!Number.isFinite(id) || id <= 0) return getReadState(userId, networkId, target);
  upsertStmt.run(userId, buffer.id, id);
  const row = getOneStmt.get(userId, buffer.id) as { lastReadId: number } | undefined;
  const lastReadId = row ? row.lastReadId : 0;
  // The stored unread count is relative to the pointer, so it moves with it —
  // here, the pointer's one writer. (A pointer written any other way just
  // reads as "not counted": see unread_after_id in db/index.ts.)
  advanceUnreadCount(buffer.id, lastReadId);
  return lastReadId;
}

// --- /clear marker state ---------------------------------------------------
//
// The clear marker lives on the same buffer_reads row as the read pointer
// (one row per user/buffer is enough), but it's controlled separately:
// /clear writes only the cleared_* columns and never touches the read
// pointer — hiding a message doesn't mark it read.

const upsertClearedStmt = db.prepare(`
  INSERT INTO buffer_reads
    (user_id, buffer_id, last_read_message_id, cleared_before_message_id, cleared_at, updated_at)
  VALUES (?, ?, 0, ?, ?, datetime('now'))
  ON CONFLICT(user_id, buffer_id) DO UPDATE SET
    cleared_before_message_id = excluded.cleared_before_message_id,
    cleared_at = excluded.cleared_at,
    updated_at = excluded.updated_at
`);

const getClearedStmt = db.prepare(`
  SELECT
    cleared_before_message_id AS clearedBeforeId,
    cleared_at AS clearedAt
  FROM buffer_reads
  WHERE user_id = ? AND buffer_id = ?
`);

const listClearedStmt = db.prepare(`
  SELECT b.network_id AS networkId, b.target AS target,
         r.cleared_before_message_id AS clearedBeforeId,
         r.cleared_at AS clearedAt
  FROM buffer_reads r JOIN buffers b ON b.id = r.buffer_id
  WHERE r.user_id = ?
    AND r.cleared_before_message_id IS NOT NULL
    AND r.cleared_before_message_id > 0
`);

export function getClearedState(
  userId: number,
  networkId: number | null,
  target: string,
): ClearedState {
  const buffer = resolveBuffer(userId, networkId, target);
  const row = buffer
    ? (getClearedStmt.get(userId, buffer.id) as
        | { clearedBeforeId: number | null; clearedAt: string | null }
        | undefined)
    : undefined;
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
  const buffer = resolveBuffer(userId, networkId, target);
  if (!buffer) return { clearedBeforeId: 0, clearedAt: null };
  const id = Number(boundaryId);
  if (!Number.isFinite(id) || id <= 0) {
    upsertClearedStmt.run(userId, buffer.id, null, null);
    return { clearedBeforeId: 0, clearedAt: null };
  }
  upsertClearedStmt.run(userId, buffer.id, id, clearedAt);
  return getClearedState(userId, networkId, target);
}

// Map keyed by `${networkId}::${target}` for buffers with an active clear
// marker. Sparse — buffers that have never been cleared aren't returned, so
// callers default to the no-clear state for missing keys.
export function listClearedStateForUser(userId: number): Record<string, ClearedState> {
  const out: Record<string, ClearedState> = {};
  for (const row of listClearedStmt.all(userId) as Array<{
    networkId: number | null;
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
