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

/**
 * Bumped whenever the resolver's LOGIC changes in a way that could turn a previous
 * `unavailable` into an `ok`.
 *
 * Folded into the cache key, so a bump orphans every old row rather than requiring a schema
 * change or a manual flush — the expiry sweep collects them in its own time.
 *
 * This is not hypothetical bookkeeping. During development the YouTube fix was invisible for
 * an hour after it shipped, because the previous code had already cached
 * `youtube.com/watch?v=…` as `unavailable` and the negative TTL had not lapsed. A fix that
 * can't be observed is a fix that gets re-debugged.
 *
 *   v2 — provider oEmbed tried before scraping; prefix reads no longer refuse oversized
 *        bodies; cache keyed by the REQUESTED url rather than the post-redirect one.
 */
const RESOLVER_VERSION = 2;

/**
 * Cache key: the requested URL, scoped to the resolver version.
 *
 * ⚠ Keyed on the URL **as asked for**, never on where it ended up after redirects. Getting
 * this wrong was a two-headed bug: the client looks a preview up by the string it sent, so a
 * descriptor echoing the post-redirect URL silently never matched and the preview never
 * rendered — and the cache was written under a key nothing would ever read, so every single
 * resolve of a redirecting URL went back out to the origin. `http://en.wikipedia.org/wiki/IRC`
 * refetched forever and displayed nothing.
 */
export function urlHash(url: string): string {
  // The fragment is client-side only and never reaches the origin, so `#intro` and `#appendix` of
  // one document are the same fetch. `normalizeUrl` strips it for exactly that stated reason —
  // but the cache keyed the RAW request string, so the documented dedupe never happened and a
  // channel linking five anchors of one page paid for five identical scrapes. Stripped here so
  // the key collapses them, while the descriptor still echoes the URL as asked (see
  // `resolvePreview`, where that echo is load-bearing for the client's own lookup).
  const key = url.replace(/#.*$/, '');
  return crypto.createHash('sha256').update(`v${RESOLVER_VERSION}|${key}`).digest('hex');
}

// ⚠ `datetime(expires_at)`, not a bare comparison. `expires_at` is stored ISO-8601
// (`2026-07-30T11:00:00.000Z`) while `datetime('now')` yields `2026-07-30 11:00:00` — and
// SQLite compares TEXT lexicographically, where 'T' (0x54) sorts after ' ' (0x20). So for any
// expiry on the SAME calendar date as now, the bare form always answered "still live": a 1-hour
// failure TTL survived until midnight UTC instead of an hour. Wrapping both sides in
// `datetime()` compares instants rather than strings.
const selectStmt = db.prepare(`
  SELECT * FROM link_previews
  WHERE url_hash = ? AND datetime(expires_at) > datetime('now')
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

const sweepStmt = db.prepare(
  `DELETE FROM link_previews WHERE datetime(expires_at) <= datetime('now')`,
);

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

/** Drop lapsed rows. Wired to a timer in server.ts — the table is a cache, so this is
 *  housekeeping rather than correctness, but without it the table only ever grows. */
export function sweepExpiredPreviews(): number {
  return sweepStmt.run().changes;
}
