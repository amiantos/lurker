// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import {
  UPLOAD_KINDS,
  extraMimesForKind,
  isUploadKind,
  type UploadKind,
} from '../../shared/uploadKinds.js';
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
  // When the owner starred this upload, or null if they haven't. See the
  // migration note in db/index.ts for why it's a timestamp and not a boolean.
  favorited_at: string | null;
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
  // Set when the owner starred it. The API ships the client a plain `favorite`
  // boolean derived from this — the timestamp itself only drives server-side
  // ordering.
  favorited_at: string | null;
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

// Re-exported so callers that already speak to this module don't need to know the
// definition moved to shared/ (it is shared with the client, which builds the same
// filter for its optimistic inserts).
export { UPLOAD_KINDS, isUploadKind, type UploadKind };

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
    favorites = false,
  }: {
    before?: number | null;
    limit?: number;
    // Substring match on filename. Not ranked retrieval — this is "find the file I
    // named", so LIKE beats reaching for FTS5 at a few thousand rows per user.
    q?: string | null;
    kind?: UploadKind | null;
    // Starred uploads only. Composes with q and kind.
    favorites?: boolean;
  } = {},
): UploadListRow[] {
  // The same ceiling for every view. It doubles as the bound on the favourites
  // view, which is fetched whole rather than paged (see the `before` note below):
  // a user with more than 200 stars gets the 200 most recently starred, and the
  // caller is expected to say so rather than imply it has them all.
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

  // Composed rather than branched: before × q × kind is 8 combinations, and the
  // previous copy-paste of the whole SELECT for one optional cursor was already the
  // start of that. Keyset pagination survives every filter — the cursor is still
  // `id < before` with a DESC scan, never OFFSET.
  const where = ['user_id = ?'];
  const params: (string | number)[] = [userId];

  if (favorites) {
    // A moderated-away upload is starred-but-gone: its bytes no longer exist, so
    // it must not sit in a quick-access list offering to insert a dead URL. It
    // still shows as a tombstone in the unfiltered browse, where that's the point.
    where.push('favorited_at IS NOT NULL AND removed = 0');
  }
  // ⚠ Only for the id-ordered views. The favourites view sorts by favorited_at, and
  // an `id < before` cursor against that ordering pages the WRONG rows — it would
  // silently drop favourites whose id happens to be high but whose star is old.
  // Favourites come back in one page instead (FAVORITES_LIMIT), so there is no
  // cursor to honour.
  if (before && !favorites) {
    where.push('id < ?');
    params.push(Number(before));
  }
  if (q) {
    where.push("filename LIKE ? ESCAPE '\\'");
    params.push(likeTerm(q));
  }
  if (kind) {
    // A prefix match on `<kind>/`, OR'd with the exact mimes that kind covers from
    // outside its prefix — today that is `application/json` under text (#788). No
    // ESCAPE needed: `kind` is validated against UPLOAD_KINDS, so it can't carry a
    // wildcard, and the extras are literals from our own table. The trailing % is
    // ours and deliberate.
    const extras = extraMimesForKind(kind);
    const clauses = ['mime LIKE ?', ...extras.map(() => 'mime = ?')];
    where.push(`(${clauses.join(' OR ')})`);
    params.push(`${kind}/%`, ...extras);
  }

  // Recency of the STAR, not of the upload — starring a two-year-old gif today
  // should put it at the front of your quick-access list, not at the bottom under
  // everything you starred before it. `id DESC` breaks ties (two stars inside the
  // same millisecond) so the order is total and paging-safe.
  const orderBy = favorites ? 'favorited_at DESC, id DESC' : 'id DESC';

  // `has_thumbnail` lets the API decide whether to advertise a thumbnail_url
  // without ever shipping the (potentially large) blob in the list response.
  return db
    .prepare(
      `
    SELECT id, provider, url, filename, mime, byte_size, width, height, created_at,
           thumbnail_url, removed, uploader_config_id, favorited_at,
           (thumbnail IS NOT NULL) AS has_thumbnail, (ref IS NOT NULL) AS has_ref
    FROM upload_history
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT ?
  `,
    )
    .all(...params, lim) as UploadListRow[];
}

// Star / unstar, user-scoped so a caller can only touch their own uploads.
// Idempotent in the sense that matters: SQLite counts a matched row as changed
// even when the value is unchanged, so re-unstarring returns true rather than
// looking like a missing row.
//
// Deliberately NOT gated on `removed`: a moderated upload that was starred before
// the takedown must still be un-starrable. Keeping it OUT of the favourites views
// is listUploads' job, not this one's.
const favoriteStmt = db.prepare(
  `UPDATE upload_history SET favorited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE user_id = ? AND id = ?`,
);
const unfavoriteStmt = db.prepare(
  'UPDATE upload_history SET favorited_at = NULL WHERE user_id = ? AND id = ?',
);

export function setUploadFavorite(userId: number, id: number, favorite: boolean): boolean {
  const stmt = favorite ? favoriteStmt : unfavoriteStmt;
  return stmt.run(userId, Number(id)).changes > 0;
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

// Drop the row unless moderation took it down meanwhile: a tombstone is the
// owner's record of why the upload went, and outlives their own delete.
export function deleteUploadUnlessRemoved(userId: number, id: number): boolean {
  return (
    db
      .prepare('DELETE FROM upload_history WHERE user_id = ? AND id = ? AND removed = 0')
      .run(userId, Number(id)).changes > 0
  );
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
const REPORT_COLS = 'id, user_id, url, thumbnail_url, mime, byte_size, width, height';

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
      `SELECT ${REPORT_COLS}
       FROM upload_history
       WHERE synced_to_cp = 0
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(lim) as UnsyncedUploadRow[];
}

// One of the user's rows, in the shape the reporter sends: a hosted delete
// reports a row the control plane hasn't indexed yet before asking again.
export function getUploadForReport(userId: number, id: number): UnsyncedUploadRow | undefined {
  return db
    .prepare(`SELECT ${REPORT_COLS} FROM upload_history WHERE user_id = ? AND id = ?`)
    .get(userId, Number(id)) as UnsyncedUploadRow | undefined;
}

// The same row only while the control plane still hasn't acknowledged it:
// dropping such a row (#1289) would take the only copy of its moderation report
// with it, so the caller reports it first.
export function getUnsyncedUploadForReport(
  userId: number,
  id: number,
): UnsyncedUploadRow | undefined {
  return db
    .prepare(
      `SELECT ${REPORT_COLS} FROM upload_history WHERE user_id = ? AND id = ? AND synced_to_cp = 0`,
    )
    .get(userId, Number(id)) as UnsyncedUploadRow | undefined;
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
