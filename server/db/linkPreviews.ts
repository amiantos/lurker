// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import crypto from 'node:crypto';
import db from './index.js';

/** What a resolved URL turned out to be. Decided from Content-Type, never from
 *  the file extension — the extension is only ever a client-side hint about
 *  which setting *would* cover a URL. */
export type PreviewKind = 'image' | 'video' | 'audio' | 'page' | 'video-embed';
export type PreviewStatus = 'ok' | 'unavailable';

export interface PreviewRecord {
  url: string;
  status: PreviewStatus;
  kind: PreviewKind;
  title: string | null;
  description: string | null;
  siteName: string | null;
  author: string | null;
  imageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  embedUrl: string | null;
  mime: string | null;
  expiresAt: string;
}

/** Successful metadata is stable — a page's og:title rarely changes, and if it
 *  does, a week-late card is a non-event. */
export const OK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Failures get a much shorter life: a 403 or a timeout is often transient (the
 *  site was down, we got challenged once), and we want another go before long —
 *  just not on every scroll. */
export const FAIL_TTL_MS = 60 * 60 * 1000;

/** Cache key. The URL itself is stored alongside for debugging; the hash is the
 *  key so a pathological 4 KB URL can't bloat the index. */
export function urlHash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex');
}

const selectStmt = db.prepare(`
  SELECT * FROM link_previews WHERE url_hash = ? AND expires_at > datetime('now')
`);

const upsertStmt = db.prepare(`
  INSERT INTO link_previews (
    url_hash, url, status, kind, title, description, site_name, author,
    image_url, image_width, image_height, embed_url, mime, fetched_at, expires_at
  ) VALUES (
    @urlHash, @url, @status, @kind, @title, @description, @siteName, @author,
    @imageUrl, @imageWidth, @imageHeight, @embedUrl, @mime, datetime('now'), @expiresAt
  )
  ON CONFLICT(url_hash) DO UPDATE SET
    status = excluded.status, kind = excluded.kind, title = excluded.title,
    description = excluded.description, site_name = excluded.site_name,
    author = excluded.author, image_url = excluded.image_url,
    image_width = excluded.image_width, image_height = excluded.image_height,
    embed_url = excluded.embed_url, mime = excluded.mime,
    fetched_at = datetime('now'), expires_at = excluded.expires_at
`);

const sweepStmt = db.prepare(`DELETE FROM link_previews WHERE expires_at <= datetime('now')`);

interface Row {
  url: string;
  status: string;
  kind: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  author: string | null;
  image_url: string | null;
  image_width: number | null;
  image_height: number | null;
  embed_url: string | null;
  mime: string | null;
  expires_at: string;
}

function toRecord(row: Row): PreviewRecord {
  return {
    url: row.url,
    status: row.status as PreviewStatus,
    kind: row.kind as PreviewKind,
    title: row.title,
    description: row.description,
    siteName: row.site_name,
    author: row.author,
    imageUrl: row.image_url,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    embedUrl: row.embed_url,
    mime: row.mime,
    expiresAt: row.expires_at,
  };
}

/** A live cache entry for this URL, or null on miss/expiry. */
export function getCachedPreview(url: string): PreviewRecord | null {
  const row = selectStmt.get(urlHash(url)) as Row | undefined;
  return row ? toRecord(row) : null;
}

export function putPreview(record: PreviewRecord): void {
  upsertStmt.run({ ...record, urlHash: urlHash(record.url) });
}

/** Drop lapsed rows. Called on a timer from server.ts — the table is a cache,
 *  so this is housekeeping, not correctness. */
export function sweepExpiredPreviews(): number {
  return sweepStmt.run().changes;
}
