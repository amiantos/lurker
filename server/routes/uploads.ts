// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import {
  advertisedUploadLimits,
  effectiveUploadCapBytes,
  formatCapMb,
} from '../services/uploadLimits.js';
import { thumbnailFormat } from '../services/thumbnailFormat.js';
import { driverIds } from '../services/uploadProviders/index.js';
import { loadDriverForRef, deletableWith } from '../services/uploadProviders/resolve.js';
import { hostedDeletable, deleteHostedUpload } from '../services/hostedUploadDelete.js';
import type { UploadListRow } from '../db/uploadHistory.js';
import {
  listUploads,
  isUploadKind,
  getThumbnail,
  getUploadForReap,
  deleteUpload,
  setUploadFavorite,
} from '../db/uploadHistory.js';
import { configuredBaseUrl, publicBaseUrl } from '../utils/publicOrigin.js';
import { capText } from '../utils/capText.js';
import { hasFreeSpaceFor } from '../utils/diskSpace.js';
import { restrictionsOf } from '../db/users.js';
import { UPLOADS_RESTRICTED } from '../../shared/accountRestrictions.js';
import {
  processUpload,
  providerErrorStatus,
  UploadRequestError,
  UPLOAD_TMP_DIR,
  uploadTempName,
} from '../services/uploadService.js';

const router = Router();
router.use(requireAuth);

// An account held off the uploaders (shared/accountRestrictions.ts) is refused
// before multer reads a byte of the body, not after the file has been spooled
// to disk and then thrown away.
function refuseIfUploadsRestricted(req: Request, res: Response, next: NextFunction): void {
  if (!restrictionsOf(req.user!).uploads) {
    res.status(403).json({ error: UPLOADS_RESTRICTED });
    return;
  }
  next();
}

// Warn once (per process) the first time a local-upload link is built from
// request headers because PUBLIC_BASE_URL isn't set. That fallback is the only
// path where a client-supplied Host/X-Forwarded-Host reaches the minted URL, so
// an operator who wants stable, un-spoofable links should set PUBLIC_BASE_URL.
let warnedRequestOriginFallback = false;

/** The instance's public base for a local upload's root-relative URL:
 *  PUBLIC_BASE_URL, else the request origin (see utils/publicOrigin). */
export function requestBaseUrl(req: Request): string {
  if (!configuredBaseUrl() && !warnedRequestOriginFallback) {
    warnedRequestOriginFallback = true;
    console.warn(
      '[lurker] PUBLIC_BASE_URL is not set; local-upload links are derived from ' +
        'the request Host/X-Forwarded-Host header, which a client can spoof. Set ' +
        'PUBLIC_BASE_URL to this instance’s public origin for stable links.',
    );
  }
  return publicBaseUrl(req);
}

// Uploads land in a temp file, never in the heap (see UPLOAD_TMP_DIR).
const TMP_DIR = UPLOAD_TMP_DIR;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP_DIR),
  filename: (_req, _file, cb) => cb(null, uploadTempName()),
});

/** Best-effort removal of an upload's temp file. Tolerates ENOENT: the `local`
 *  driver RENAMES the temp file into its storage dir (zero copies), so by the time
 *  we clean up there may be nothing left to remove — which is the good case. */
async function discardTemp(file?: Express.Multer.File): Promise<void> {
  if (!file?.path) return;
  await fs.promises.unlink(file.path).catch(() => {});
}

/**
 * Delete temp uploads left behind by a crash (an in-flight upload when the process
 * died — the one case the handler's `finally` can't cover). Called once at boot.
 * Age-gated so it can never race a live upload in another worker: only files older
 * than the request timeout are candidates.
 */
export async function sweepTempUploads(maxAgeMs = 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.promises.readdir(TMP_DIR);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    if (!name.startsWith('up-')) continue;
    const full = path.join(TMP_DIR, name);
    try {
      const stat = await fs.promises.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.unlink(full);
        removed++;
      }
    } catch {
      // vanished under us (another sweep, or the handler finishing) — fine
    }
  }
  if (removed > 0) console.log(`[lurker] swept ${removed} orphaned upload temp file(s)`);
  return removed;
}

// The cap handed to multer is resolved BEFORE a byte is read (requireAuth already
// ran, so we know who's asking). The old code gave multer a flat 200 MB and let the
// handler reject afterwards — which meant a user capped at 25 MB could still make
// the server ingest 200 MB before being told no. The per-upload `uploaderId`
// override lives in the multipart body, which isn't parsed yet, so this resolves the
// DEFAULT uploader's cap; the handler re-checks against the actually-resolved
// uploader, which is what catches an override with a tighter policy cap.
const uploadToDisk = (req: Request, res: Response, next: NextFunction): void => {
  const capBytes = effectiveUploadCapBytes(req.user!.id, req.user!.role === 'admin');
  // The same free-disk floor an upload session checks (#650): with the ceiling
  // the admin's to raise (#1131), a single request can be as large as the disk,
  // and this temp file shares that disk with the database. The body's declared
  // length is the honest estimate (the file plus its multipart envelope); a
  // body that declares none, or more than the cap, can land at most the cap.
  const declared = Number(req.headers['content-length']);
  const expected =
    Number.isFinite(declared) && declared > 0 ? Math.min(declared, capBytes) : capBytes;
  if (!hasFreeSpaceFor(TMP_DIR, expected)) {
    res.status(507).json({ error: 'not enough free disk space on the server for this file' });
    return;
  }
  const handler = multer({
    storage,
    limits: { fileSize: capBytes, files: 1 },
    // busboy decodes multipart params as LATIN-1 unless told otherwise, so any
    // non-ASCII filename arrives mangled — a macOS screen recording is named with a
    // narrow no-break space (U+202F) before AM/PM, whose UTF-8 bytes (E2 80 AF) then
    // show up in the uploads list as "â¯". Browsers send the header in UTF-8.
    defParamCharset: 'utf8',
  }).single('image');
  handler(req, res, (err: unknown) => {
    // multer aborts the stream and unlinks its partial file once the cap is hit,
    // so an oversized upload is refused mid-flight instead of after we've eaten it.
    if ((err as { code?: string })?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `file exceeds ${formatCapMb(capBytes)} MB` });
      return;
    }
    next(err as Error | undefined);
  });
};

router.post(
  '/',
  refuseIfUploadsRestricted,
  uploadToDisk,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'no file uploaded' });
        return;
      }

      // Per-upload override (design decision 9): send this one file somewhere
      // other than your default. Multipart, so it arrives as a string field. An
      // override that isn't in the caller's allowed set is a 400, never a silent
      // reroute to their default (decision 15).
      const requestedRaw = (req.body as { uploaderId?: unknown } | undefined)?.uploaderId;
      const requestedId = requestedRaw == null || requestedRaw === '' ? null : Number(requestedRaw);
      if (requestedId != null && !Number.isInteger(requestedId)) {
        res.status(400).json({ error: 'uploaderId must be an integer' });
        return;
      }

      // Correlation token for the progress events (#545). The client's own random
      // string, arriving as a multipart text field like uploaderId does.
      const tokenRaw = (req.body as { progressToken?: unknown } | undefined)?.progressToken;

      // What the file is for: an ordinary upload, or an avatar the profile editor
      // has cropped (#1189). A field like the others, sent before the file.
      const purpose = (req.body as { purpose?: unknown } | undefined)?.purpose ?? 'upload';
      if (purpose !== 'upload' && purpose !== 'avatar') {
        res.status(400).json({ error: "purpose must be 'upload' or 'avatar'" });
        return;
      }

      const uploaded = await processUpload({
        userId: req.user!.id,
        isAdmin: req.user!.role === 'admin',
        tempPath: req.file.path,
        size: req.file.size,
        claimedMime: req.file.mimetype,
        originalName: req.file.originalname,
        requestedUploaderId: requestedId,
        progressToken: typeof tokenRaw === 'string' && tokenRaw ? capText(tokenRaw, 64) : null,
        avatar: purpose === 'avatar',
        baseUrl: () => requestBaseUrl(req),
      });
      res.json(uploaded);
    } catch (err) {
      if (err instanceof UploadRequestError) {
        res.status(err.status).json({ error: err.message, ...err.extra });
        return;
      }
      next(err);
    } finally {
      // Every exit takes the temp file with it: success, 4xx/5xx, driver failure,
      // or a throw. (A client abort never reaches the handler — multer unlinks its
      // own partial file — and sweepTempUploads() catches anything a crash left.)
      await discardTemp(req.file);
    }
  },
);

// Can rows produced by this configured uploader have their bytes destroyed?
// Same resolution the DELETE gate uses (loadDriverForRef → deletableWith), so
// the list can never advertise a button the route would refuse. Memoized per
// request — a page of history rows references very few configs.
function configDeletableCheck(): (configId: number | null) => boolean {
  const memo = new Map<number, boolean>();
  return (configId) => {
    if (configId == null) return false;
    let known = memo.get(configId);
    if (known === undefined) {
      const loaded = loadDriverForRef(configId);
      known = loaded != null && deletableWith(loaded.driver, loaded.driverConfig);
      memo.set(configId, known);
    }
    return known;
  };
}

router.get('/', (req: Request, res: Response) => {
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  // Search has to happen HERE, not in the client (#547): the client only holds the
  // pages it has scrolled through, and the whole point is finding one it hasn't. This
  // is the exception to the filters-are-client-side default, and the reason is
  // delivery, not preference.
  const rawQ = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const q = rawQ ? capText(rawQ, 200) : null;
  // An unknown kind is ignored rather than 400'd: it can only come from a client we
  // shipped, and silently showing everything beats erroring out of a browse.
  const kind = isUploadKind(req.query.kind) ? req.query.kind : null;
  // Starred-only. `limit` still applies exactly as it does everywhere else (the
  // composer's picker asks for a couple of rows' worth) — what does NOT apply is
  // `before`: listUploads orders this view by when the upload was starred, and an
  // id cursor against that ordering pages the wrong rows, so it ignores one. A
  // caller wanting the whole curated set asks for it with limit.
  const favorites = req.query.favorites === '1' || req.query.favorites === 'true';
  const rows: UploadListRow[] = listUploads(req.user!.id, { before, limit, q, kind, favorites });
  const configDeletable = configDeletableCheck();
  // Hosted rows are deleted through the control plane, not a driver handle.
  const isAdmin = req.user!.role === 'admin';
  res.json({
    items: rows.map((r) => {
      const { has_thumbnail, thumbnail_url, removed, uploader_config_id, has_ref, ...rest } = r;
      // The client only ever needs "is it starred"; the timestamp exists to order
      // the favourites view server-side and never leaves the server.
      const { favorited_at, ...item } = rest;
      const favorite = favorited_at != null;
      // A moderated-away upload keeps its row as a tombstone, but its bytes are
      // gone — advertise no thumbnail so the client renders the tombstone.
      if (removed) return { ...item, favorite, removed: true };
      // A row is deletable only when its bytes can actually be destroyed: the
      // driver captured a delete handle at upload time AND its configured
      // uploader still exists with a delete-capable driver. No ref (x0, anonymous
      // catbox, pre-#541 rows) → the client never shows a delete button.
      const can_delete =
        hostedDeletable({ provider: r.provider, uploader_config_id }, isAdmin) ||
        (Boolean(has_ref) && configDeletable(uploader_config_id));
      // Prefer a remote CDN thumbnail; otherwise fall back to the local
      // BLOB-serving route when an inline thumbnail exists.
      const thumb = thumbnail_url || (has_thumbnail ? `/api/uploads/${r.id}/thumb` : null);
      return { ...item, favorite, can_delete, ...(thumb ? { thumbnail_url: thumb } : {}) };
    }),
    providers: driverIds,
    // The same numbers the snapshot advertises (#627 cap, #872 static-image
    // dimension), repeated here so a REST-only client browsing its uploads doesn't
    // need the WebSocket to learn what it may send. Single source of truth, so the
    // two can't drift.
    ...advertisedUploadLimits(req.user!.id, req.user!.role === 'admin'),
  });
});

router.get('/:id/thumb', (req: Request, res: Response) => {
  const row = getThumbnail(req.user!.id, Number(req.params.id));
  // No inline BLOB → nothing to serve here. Remote-thumbnail uploads keep their
  // thumbnail as a CDN object (thumbnail_url) the client uses directly.
  if (!row || !row.thumbnail) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Sniffed, not named: thumbnails stored before #560 are jpeg and those rows
  // outlive the format setting, so this route serves a mix forever.
  res.setHeader('Content-Type', thumbnailFormat(row.thumbnail).mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(row.thumbnail);
});

// Star / unstar an upload — the user's own quick-access set. Server-side rather
// than a local preference so the same starred gifs are at hand on every device
// the account is signed in on.
//
// Its own subpath rather than a field on a PATCH of the row: everything else about
// an upload is immutable once captured (the bytes, the mime, where it landed), and
// a general-purpose PATCH would imply otherwise. `/:id` never matches `/:id/favorite`
// — an Express path param does not span a `/` — so this sits beside DELETE /:id
// without shadowing it.
router.put('/:id/favorite', (req: Request, res: Response) => {
  if (!setUploadFavorite(req.user!.id, Number(req.params.id), true)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true, favorite: true });
});

router.delete('/:id/favorite', (req: Request, res: Response) => {
  if (!setUploadFavorite(req.user!.id, Number(req.params.id), false)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true, favorite: false });
});

// Delete = destroy the bytes, then drop the row (decision 8, revised). There is
// deliberately NO "remove the record but leave the file up" path: rows whose
// bytes can't be destroyed (no ref, driver can't delete, config gone, moderation
// tombstone) are refused — the client never offered a button for them, so a
// request for one is forged or stale. Bytes go first so a driver failure keeps
// the row and the user can retry; drivers treat "already gone" as success.
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  // Ownership is enforced by the user-scoped lookup — a caller can only
  // delete their own upload.
  const row = getUploadForReap(req.user!.id, id);
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Hosted (node edition): the control plane deletes the bytes, since the cell
  // holds no delete key (control-plane #55). Anything else goes to its driver.
  if (!row.removed && hostedDeletable(row, req.user!.role === 'admin')) {
    const out = await deleteHostedUpload(req.user!.id, id);
    if (!out.ok) {
      if (out.retryAfter) res.set('Retry-After', String(out.retryAfter));
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json({ ok: true });
    return;
  }
  const loaded =
    row.ref && !row.removed && row.uploader_config_id != null
      ? loadDriverForRef(row.uploader_config_id)
      : null;
  if (!loaded || !deletableWith(loaded.driver, loaded.driverConfig)) {
    res.status(409).json({ error: 'this upload cannot be deleted' });
    return;
  }
  try {
    await loaded.driver.delete!(row.ref!, loaded.driverConfig);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    res
      .status(providerErrorStatus(e))
      .json({ error: e.message || 'delete failed', provider: row.provider });
    return;
  }
  deleteUpload(req.user!.id, id);
  res.json({ ok: true });
});

export default router;
