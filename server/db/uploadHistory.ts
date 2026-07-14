// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** A row from the `upload_history` table. */
export interface UploadHistoryRow {
  id: number;
  user_id: number;
  provider: string;
  url: string;
  filename: string | null;
  mime: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  thumbnail: Buffer | null;
  thumbnail_url: string | null;
  created_at: string;
}

/**
 * List row shape — omits the thumbnail blob, adds has_thumbnail flag. Carries
 * thumbnail_url so the API can prefer a remote CDN thumbnail (node edition) over
 * the local BLOB-serving route.
 */
export interface UploadListRow {
  id: number;
  provider: string;
  url: string;
  filename: string | null;
  mime: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  created_at: string;
  has_thumbnail: number;
  thumbnail_url: string | null;
  // 1 once the control plane has moderated the upload away. The row stays so the
  // owner sees a tombstone, but its bytes are gone from storage.
  removed: number;
  // Which configured uploader produced the row, and whether the driver handed
  // back a delete handle — the API derives the row's `can_delete` from these
  // (never shipping the ref itself to the client).
  uploader_config_id: number | null;
  has_ref: number;
}

/** Fields passed to insertUpload. */
export interface InsertUploadFields {
  provider: string;
  url: string;
  filename?: string | null;
  mime: string;
  byte_size: number;
  width?: number | null;
  height?: number | null;
  // Exactly one of thumbnail (inline BLOB, self-host) or thumbnail_url (remote
  // CDN object) is set; both null for thumbnail-less uploads (txt).
  thumbnail: Buffer | null;
  thumbnail_url?: string | null;
  // The configured uploader (uploader_config.id) that produced this upload, and
  // the driver's opaque delete handle. Both nullable in P0 (no path reads them
  // back yet) — the seam later phases (delete, s3/local) build on.
  uploader_config_id?: number | null;
  ref?: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO upload_history
    (user_id, provider, url, filename, mime, byte_size, width, height, thumbnail,
     thumbnail_url, uploader_config_id, ref)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function insertUpload(userId: number, row: InsertUploadFields): number {
  const info = insertStmt.run(
    userId,
    row.provider,
    row.url,
    row.filename ?? null,
    row.mime,
    row.byte_size,
    row.width ?? null,
    row.height ?? null,
    row.thumbnail,
    row.thumbnail_url ?? null,
    row.uploader_config_id ?? null,
    row.ref ?? null,
  );
  return Number(info.lastInsertRowid);
}

// The kinds the uploads browser filters by (#547), and the mime prefix each one
// means. Derived from `mime` rather than stored: the mime is already the magic-byte
// truth (contentClass.ts sniffs it), so a separate column would be a second source
// of it that could disagree.
export const UPLOAD_KINDS = ['image', 'video', 'audio', 'text'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export function isUploadKind(value: unknown): value is UploadKind {
  return typeof value === 'string' && (UPLOAD_KINDS as readonly string[]).includes(value);
}

/**
 * Escape a user's search term for a SQL LIKE pattern.
 *
 * ⚠ Without this, `%` and `_` typed by the user are WILDCARDS, not characters: a
 * search for "100%" matches every filename containing "100", and a lone "_" matches
 * everything. `\` must go first, or it would escape the escapes we just added.
 */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function listUploads(
  userId: number,
  {
    before = null,
    limit = 50,
    q = null,
    kind = null,
  }: {
    before?: number | null;
    limit?: number;
    // Substring match on filename. Not ranked retrieval — this is "find the file I
    // named", so LIKE beats reaching for FTS5 at a few thousand rows per user.
    q?: string | null;
    kind?: UploadKind | null;
  } = {},
): UploadListRow[] {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

  // Composed rather than branched: before × q × kind is 8 combinations, and the
  // previous copy-paste of the whole SELECT for one optional cursor was already the
  // start of that. Keyset pagination survives every filter — the cursor is still
  // `id < before` with a DESC scan, never OFFSET.
  const where = ['user_id = ?'];
  const params: (string | number)[] = [userId];

  if (before) {
    where.push('id < ?');
    params.push(Number(before));
  }
  if (q) {
    where.push("filename LIKE ? ESCAPE '\\'");
    params.push(likeTerm(q));
  }
  if (kind) {
    where.push('mime LIKE ?');
    // No ESCAPE needed: `kind` is validated against UPLOAD_KINDS, so it can't carry
    // a wildcard. The trailing % is ours and deliberate.
    params.push(`${kind}/%`);
  }

  // `has_thumbnail` lets the API decide whether to advertise a thumbnail_url
  // without ever shipping the (potentially large) blob in the list response.
  return db
    .prepare(
      `
    SELECT id, provider, url, filename, mime, byte_size, width, height, created_at,
           thumbnail_url, removed, uploader_config_id,
           (thumbnail IS NOT NULL) AS has_thumbnail, (ref IS NOT NULL) AS has_ref
    FROM upload_history
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?
  `,
    )
    .all(...params, lim) as UploadListRow[];
}

export function getThumbnail(userId: number, id: number): { thumbnail: Buffer | null } | undefined {
  return db
    .prepare(
      `
    SELECT thumbnail FROM upload_history
    WHERE user_id = ? AND id = ?
  `,
    )
    .get(userId, Number(id)) as { thumbnail: Buffer | null } | undefined;
}

/** The delete-reap view of a row: which configured uploader produced it and the
 *  driver's opaque on-storage handle, so the caller can unlink the bytes for
 *  drivers that own their storage (local, s3). User-scoped, so a caller can only
 *  reap their own uploads. */
export interface UploadReapRow {
  uploader_config_id: number | null;
  ref: string | null;
  provider: string;
  removed: number;
}

export function getUploadForReap(userId: number, id: number): UploadReapRow | undefined {
  return db
    .prepare(
      'SELECT uploader_config_id, ref, provider, removed FROM upload_history WHERE user_id = ? AND id = ?',
    )
    .get(userId, Number(id)) as UploadReapRow | undefined;
}

export function deleteUpload(userId: number, id: number): boolean {
  const info = db
    .prepare(
      `
    DELETE FROM upload_history WHERE user_id = ? AND id = ?
  `,
    )
    .run(userId, Number(id));
  return info.changes > 0;
}

/** A row the moderation reporter still needs to push to the control plane. */
export interface UnsyncedUploadRow {
  id: number;
  user_id: number;
  url: string;
  thumbnail_url: string | null;
  mime: string;
  byte_size: number;
  width: number | null;
  height: number | null;
}

// Node-edition rows not yet acknowledged by the control plane's moderation
// index. Drained by the periodic flush so a CP outage at upload time is
// eventually reconciled rather than losing the record. Oldest first.
export function listUnsyncedUploads(limit = 50): UnsyncedUploadRow[] {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  return db
    .prepare(
      `SELECT id, user_id, url, thumbnail_url, mime, byte_size, width, height
       FROM upload_history
       WHERE synced_to_cp = 0
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(lim) as UnsyncedUploadRow[];
}

export function markUploadSynced(id: number): void {
  db.prepare('UPDATE upload_history SET synced_to_cp = 1 WHERE id = ?').run(Number(id));
}

// Control-plane-driven moderation takedown, addressed by the cell's own upload
// id (what the cell reported as cell_upload_id). Flips the row to `removed` and
// drops any inline thumbnail BLOB so the bytes are gone locally too — the row
// stays as a tombstone. Not user-scoped: this is a privileged node-API action,
// never a tenant request. Idempotent; returns whether a row matched.
export function markUploadRemovedById(id: number): boolean {
  const info = db
    .prepare('UPDATE upload_history SET removed = 1, thumbnail = NULL WHERE id = ?')
    .run(Number(id));
  return info.changes > 0;
}
