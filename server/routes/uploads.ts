// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { resolveDataDir } from '../utils/dataDir.js';
import { randomId } from '../services/uploadProviders/objectKey.js';
import { bufferSource, fileSource, type UploadSource } from '../services/uploadProviders/source.js';
import { getUserSettings } from '../db/settings.js';
import { defaultsAsObject } from '../services/settingsRegistry.js';
import * as imagePipeline from '../services/imagePipeline.js';
import { driverIds } from '../services/uploadProviders/index.js';
import {
  classifyUpload,
  UnsupportedTypeError,
  type Classification,
} from '../services/contentClass.js';
import { scrubMediaFile, MediaScrubError } from '../services/mediaScrub.js';
import {
  resolveUploader,
  loadDriverForRef,
  deletableWith,
  UploaderUnavailableError,
  UploaderNotConfiguredError,
  type ResolvedUploader,
} from '../services/uploadProviders/resolve.js';
import type { UploadListRow } from '../db/uploadHistory.js';
import {
  insertUpload,
  listUploads,
  getThumbnail,
  getUploadForReap,
  deleteUpload,
} from '../db/uploadHistory.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { reportUploadSoon } from '../services/moderationReport.js';

const router = Router();
router.use(requireAuth);

// Resolve effective settings with registry defaults filled in. The per-user
// image-pipeline settings (size cap, max dimension, JPEG quality) are the
// fallback used when the resolved uploader carries no operator-baked policy caps
// — i.e. every self-host uploader. Untyped (JS module) → Record<string, unknown>.
function effectiveSettings(userId: number): Record<string, unknown> {
  return { ...defaultsAsObject(), ...getUserSettings(userId) };
}

// The absolute origin (scheme + host) a `local` upload's relative URL is prefixed
// with so the pasted link works from IRC. PUBLIC_BASE_URL wins (explicit,
// proxy-safe); otherwise derive from the request, honoring the reverse-proxy
// forwarding headers a self-hoster's Caddy/nginx sets. Read here rather than via
// a global `trust proxy` so the rest of the app's request handling is unchanged.
// A forwarding header may be a list ("proto1, proto2"); take the first hop.
function firstHeaderValue(v: unknown): string {
  return String(v ?? '')
    .split(',')[0]
    .trim();
}

// A host is hostname[:port] or [ipv6][:port] — reject anything with characters
// that could break out of the authority (slash, space, userinfo '@', etc.), so a
// spoofed header can never inject path/scheme into the URL we construct + persist.
const HOST_RE = /^[A-Za-z0-9.\-:[\]]+$/;

function requestOrigin(req: Request): string {
  // Only http/https are valid schemes; anything else (a spoofed "javascript" or
  // garbage X-Forwarded-Proto) is ignored so it can never reach the built URL.
  const rawProto = firstHeaderValue(req.headers['x-forwarded-proto']) || req.protocol;
  const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : 'https';
  const rawHost = firstHeaderValue(req.headers['x-forwarded-host']) || req.get('host') || '';
  const host = HOST_RE.test(rawHost) ? rawHost : '';
  return host ? `${proto}://${host}` : '';
}

// Warn once (per process) the first time a local-upload link is built from
// request headers because PUBLIC_BASE_URL isn't set. That fallback is the only
// path where a client-supplied Host/X-Forwarded-Host reaches the minted URL, so
// an operator who wants stable, un-spoofable links should set PUBLIC_BASE_URL.
let warnedRequestOriginFallback = false;

/** Absolutize a driver result URL. Drivers that store remotely already return an
 *  absolute URL; the local driver returns a root-relative path we prefix with the
 *  instance's public base (PUBLIC_BASE_URL, else the request origin). */
function absolutizeUrl(url: string, storesRemotely: boolean, req: Request): string {
  if (storesRemotely || !url.startsWith('/')) return url;
  const configured = process.env.PUBLIC_BASE_URL;
  if (!configured && !warnedRequestOriginFallback) {
    warnedRequestOriginFallback = true;
    console.warn(
      '[lurker] PUBLIC_BASE_URL is not set; local-upload links are derived from ' +
        'the request Host/X-Forwarded-Host header, which a client can spoof. Set ' +
        'PUBLIC_BASE_URL to this instance’s public origin for stable links.',
    );
  }
  const base = (configured || requestOrigin(req)).replace(/\/+$/, '');
  return base ? base + url : url;
}

// Map a driver error onto an HTTP status. PROVIDER_AUTH deliberately does NOT
// become 401: that's the provider rejecting the uploader's stored credential,
// not the caller's Lurker session — and the client's api() treats any 401 as a
// dead session and hard-reloads to the login page. Upstream failures of every
// kind are 502; only a config the user can fix themselves is a 400.
function providerErrorStatus(e: { code?: string }): number {
  return e.code === 'PROVIDER_CONFIG' ? 400 : 502;
}

// Uploads land in a temp file, never in the heap. multer's memoryStorage used to
// hold the whole file, and the drivers then copied it again (and fetch copied it a
// third time) — a 200 MB upload cost ~1 GB of RSS. See services/uploadProviders/
// source.ts for the measurements. Everything downstream takes an UploadSource.
// 0o700: an in-flight upload is the user's private data and must not be readable
// by other local users on a shared host. Matches routes/exports.ts's staged-import
// posture.
const TMP_DIR = path.join(resolveDataDir(), 'tmp', 'uploads');
fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });

// The registry's own ceiling; a per-user cap can't exceed it, so neither can multer.
const MAX_CAP_MB = 200;

/** The user's size cap. effectiveSettings() has already merged the registry default
 *  in, so this reads it from ONE place — a second hardcoded default here would be a
 *  duplicate that quietly disagrees the next time the registry's changes. */
function userCapMb(settings: Record<string, unknown>): number {
  const n = Number(settings['uploads.image.max_upload_mb']);
  return Number.isFinite(n) && n > 0 ? n : MAX_CAP_MB;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TMP_DIR),
  filename: (_req, _file, cb) => cb(null, `up-${randomId()}`),
});

/** The cap to hand multer, resolved BEFORE a byte is read (requireAuth already
 *  ran, so we know who's asking). The old code gave multer a flat 200 MB and let
 *  the handler reject afterwards — which meant a user capped at 25 MB could still
 *  make the server ingest 200 MB before being told no. The per-upload `uploaderId`
 *  override lives in the multipart body, which isn't parsed yet, so this resolves
 *  the DEFAULT uploader's cap; the handler re-checks against the actually-resolved
 *  uploader, which is what catches an override with a tighter policy cap. */
function capMbFor(userId: number, isAdmin: boolean): number {
  const settings = effectiveSettings(userId);
  const userCap = userCapMb(settings);
  let cap = userCap;
  try {
    cap = resolveUploader({ userId, isAdmin, requestedId: null }).policy.maxMb ?? userCap;
  } catch {
    // No usable uploader → the handler will produce the real error. Fall back to
    // the user's own cap so we still bound what we're willing to read.
  }
  return Math.max(1, Math.min(cap, MAX_CAP_MB));
}

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

const uploadToDisk = (req: Request, res: Response, next: NextFunction): void => {
  const capMb = capMbFor(req.user!.id, req.user!.role === 'admin');
  const handler = multer({
    storage,
    limits: { fileSize: capMb * 1024 * 1024, files: 1 },
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
      res.status(413).json({ error: `file exceeds ${capMb} MB` });
      return;
    }
    next(err as Error | undefined);
  });
};

router.post(
  '/',
  uploadToDisk,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'no file uploaded' });
        return;
      }

      // Resolve the configured uploader. Every isNodeMode() branch the old route
      // made (which provider, whose credentials, which caps, SVG policy, thumbnail
      // strategy) is now derived from the resolved uploader's driver + policy.
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

      let resolved: ResolvedUploader;
      try {
        resolved = resolveUploader({
          userId: req.user!.id,
          isAdmin: req.user!.role === 'admin',
          requestedId,
        });
      } catch (err) {
        // A locked instance default that the operator hasn't configured →
        // server-side 503 (was: isNodeMode() && !nodeUploadConfigured()).
        if (err instanceof UploaderNotConfiguredError) {
          res.status(503).json({ error: err.message });
          return;
        }
        // No usable uploader for this account → ask the user to pick one.
        if (err instanceof UploaderUnavailableError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }

      const settings = effectiveSettings(req.user!.id);
      // Size cap: operator-baked policy (hosted locked uploader) wins; otherwise
      // the user's own setting. A tenant can't lift a policy cap because the
      // policy is on the instance row, not their settings.
      const maxMb = resolved.policy.maxMb ?? userCapMb(settings);
      if (req.file.size > maxMb * 1024 * 1024) {
        res.status(413).json({ error: `file exceeds ${maxMb} MB` });
        return;
      }

      // Classify from the MAGIC BYTES, never the client's claimed MIME (#515). The
      // claim used to decide this, which was survivable only while the alternative
      // branch was the image pipeline — the moment a class means "passthrough", a
      // claimed MIME is a route around imagePipeline.optimize(), and that's where
      // the EXIF scrub lives. See services/contentClass.ts.
      let classified: Classification;
      try {
        classified = await classifyUpload(req.file.path, req.file.mimetype);
      } catch (err) {
        if (err instanceof UnsupportedTypeError) {
          res.status(415).json({ error: err.message });
          return;
        }
        throw err;
      }
      const contentClass = classified.contentClass;

      // Validate stage: the resolved driver must accept this class. This is what
      // makes hosted (whose dropper takes images + text only) refuse media, without
      // a policy flag anywhere.
      if (!resolved.driver.capabilities.acceptsContentClasses.includes(contentClass)) {
        res.status(415).json({
          error: `${resolved.driver.label} does not accept ${contentClass} files`,
        });
        return;
      }

      let outSource: UploadSource;
      let outMime: string;
      let outExt: string;
      let outByteSize: number;
      let outWidth: number | null = null;
      let outHeight: number | null = null;
      let thumb: Buffer | null = null;

      if (contentClass === 'text' || contentClass === 'media') {
        // Passthrough: the bytes go out of the temp file exactly as they came in.
        // Nothing reads them into memory — the driver streams the file (#543).
        if (contentClass === 'media') {
          // …except the metadata, which is stripped in place first. A phone's MP4
          // carries GPS in moov/udta; passing it through untouched would re-open
          // exactly the leak #516 closed for photos. The scrub is size-preserving,
          // so req.file.size stays correct.
          try {
            await scrubMediaFile(req.file.path, classified.mime);
          } catch (err) {
            if (err instanceof MediaScrubError) {
              res.status(415).json({ error: err.message });
              return;
            }
            throw err;
          }
        }
        // Re-stat rather than reuse req.file.size. The scrub is size-preserving by
        // construction — that's the whole reason boxes are retyped to `free` instead
        // of removed — but this size becomes the upload's Content-Length, and a
        // wrong one truncates the body or hangs the request. Don't make a network
        // framing invariant depend on a promise made in another module's comment.
        const { size: bytesOnDisk } = await fs.promises.stat(req.file.path);
        outSource = fileSource(req.file.path, bytesOnDisk);
        outMime = classified.mime;
        outExt = classified.ext;
        outByteSize = bytesOnDisk;
      } else {
        // The output format is the user's, with no policy override: unlike maxDim/
        // quality/maxMb it isn't a cost lever the operator needs to bake, and the
        // hosted dropper accepts both webp and jpeg (#560).
        const format: imagePipeline.OutputFormat =
          settings['uploads.image.format'] === 'jpeg' ? 'jpeg' : 'webp';
        const quality =
          resolved.policy.quality ?? (Number(settings['uploads.image.quality']) || 85);
        // imagePipeline is an untyped JS module — any is unavoidable here
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let optimized: any;
        try {
          optimized = await imagePipeline.optimize(req.file.path, {
            maxDim:
              resolved.policy.maxDim ?? (Number(settings['uploads.image.max_dimension']) || 2048),
            quality,
            format,
            // SVG is rejected only where the resolved uploader's policy says so
            // (the hosted locked uploader serves raster + .txt). Self-host keeps
            // the SVG passthrough. Was: rasterOnly = isNodeMode().
            rasterOnly: resolved.policy.rasterOnly,
          });
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e.code === 'UNSUPPORTED_FORMAT') {
            res.status(415).json({ error: e.message });
            return;
          }
          throw err;
        }
        thumb = (await imagePipeline.thumbnail(req.file.path, { format })) as Buffer | null;
        // The optimized image is small and bounded (resized + re-encoded), so it
        // stays a buffer — round-tripping it through another temp file would be
        // pointless I/O. The heap blowup this PR removes was the ORIGINAL bytes.
        outSource = bufferSource(optimized.buffer as Buffer);
        outMime = optimized.mime as string;
        outExt = optimized.ext as string;
        outByteSize = optimized.byteSize as number;
        outWidth = optimized.width as number | null;
        outHeight = optimized.height as number | null;
      }

      const originalName = req.file.originalname || '';
      const baseName = originalName.replace(/\.[^.]+$/, '') || `upload-${Date.now()}`;
      const filename = `${baseName}.${outExt}`;

      // provider.upload is from an untyped JS module boundary
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      try {
        result = await resolved.driver.upload(
          outSource,
          { filename, mime: outMime, contentClass },
          resolved.driverConfig,
        );
      } catch (err) {
        const e = err as { code?: string; message?: string };
        res.status(providerErrorStatus(e)).json({ error: e.message, provider: resolved.driverId });
        return;
      }

      const storesRemotely = resolved.driver.capabilities.storesRemotely;
      const mainUrl = absolutizeUrl(result.url as string, storesRemotely, req);

      // Thumbnail strategy is a resolved policy value, not isNodeMode(): a
      // hostsThumbnails uploader (the hosted in-house one) stores the thumb as a
      // remote object under a `thumbs/` prefix so it doesn't bloat the cell DB /
      // R2 backups; everyone else keeps the inline BLOB. Best-effort: a thumb
      // upload failure falls back to the BLOB so a hiccup never blocks the user.
      let thumbnailBlob: Buffer | null = thumb;
      let thumbnailUrl: string | null = null;
      if (resolved.policy.hostsThumbnails && thumb) {
        try {
          // Describe the bytes we actually produced, not the format thumbnails
          // used to be: the dropper verifies the claimed mime against the magic
          // bytes and 415s a webp announced as image/jpeg.
          const thumbMime = imagePipeline.thumbnailMime(thumb);
          const tRes = await resolved.driver.upload(
            bufferSource(thumb),
            {
              filename: `thumb.${imagePipeline.extensionFor(thumbMime, 'jpg')}`,
              mime: thumbMime,
              contentClass: 'image',
              kind: 'thumb',
            },
            resolved.driverConfig,
          );
          if (tRes && typeof tRes.url === 'string') {
            thumbnailUrl = absolutizeUrl(tRes.url, storesRemotely, req);
            thumbnailBlob = null;
          }
        } catch {
          // keep thumbnailBlob — fall back to the inline BLOB
        }
      }

      const id = insertUpload(req.user!.id, {
        provider: resolved.driverId,
        url: mainUrl,
        filename: originalName || null,
        mime: outMime,
        byte_size: outByteSize,
        width: outWidth,
        height: outHeight,
        thumbnail: thumbnailBlob,
        thumbnail_url: thumbnailUrl,
        uploader_config_id: resolved.configId,
        ref: (result.ref as string | undefined) ?? null,
      });

      // Report the upload to the control plane's moderation index. Self-gates to
      // a no-op in standalone (no control plane configured), so it's called
      // unconditionally; fire-and-forget, never blocks the response.
      reportUploadSoon({
        cell_upload_id: id,
        cell_user_id: req.user!.id,
        url: mainUrl,
        thumb_url: thumbnailUrl,
        mime: outMime,
        byte_size: outByteSize,
        width: outWidth,
        height: outHeight,
      });

      // Deletability is decided at capture time (decision 8): the driver returned
      // a ref only if this specific upload's bytes can be destroyed later.
      const canDelete =
        Boolean(result.ref) && deletableWith(resolved.driver, resolved.driverConfig);
      res.json({
        id,
        url: mainUrl,
        // The REAL mime, derived from the bytes — the client builds its optimistic
        // history row from this rather than from what the browser guessed, so the
        // row's type icon isn't a lie until the next refetch.
        mime: outMime,
        can_delete: canDelete,
        ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
      });
    } catch (err) {
      next(err);
    } finally {
      // Every exit takes the temp file with it: success, 4xx/5xx, driver failure,
      // or a throw. (A client abort never reaches the handler — multer unlinks its
      // own partial file — and sweepTempUploads() catches anything a crash left.)
      await discardTemp(req.file);
    }
  }),
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
  const rows: UploadListRow[] = listUploads(req.user!.id, { before, limit });
  const configDeletable = configDeletableCheck();
  res.json({
    items: rows.map((r) => {
      const { has_thumbnail, thumbnail_url, removed, uploader_config_id, has_ref, ...rest } = r;
      // A moderated-away upload keeps its row as a tombstone, but its bytes are
      // gone — advertise no thumbnail so the client renders the tombstone.
      if (removed) return { ...rest, removed: true };
      // A row is deletable only when its bytes can actually be destroyed: the
      // driver captured a delete handle at upload time AND its configured
      // uploader still exists with a delete-capable driver. No ref (x0, anonymous
      // catbox, pre-#541 rows) → the client never shows a delete button.
      const can_delete = Boolean(has_ref) && configDeletable(uploader_config_id);
      // Prefer a remote CDN thumbnail; otherwise fall back to the local
      // BLOB-serving route when an inline thumbnail exists.
      const thumb = thumbnail_url || (has_thumbnail ? `/api/uploads/${r.id}/thumb` : null);
      return { ...rest, can_delete, ...(thumb ? { thumbnail_url: thumb } : {}) };
    }),
    providers: driverIds,
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
  res.setHeader('Content-Type', imagePipeline.thumbnailMime(row.thumbnail));
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(row.thumbnail);
});

// Delete = destroy the bytes, then drop the row (decision 8, revised). There is
// deliberately NO "remove the record but leave the file up" path: rows whose
// bytes can't be destroyed (no ref, driver can't delete, config gone, moderation
// tombstone) are refused — the client never offered a button for them, so a
// request for one is forged or stale. Bytes go first so a driver failure keeps
// the row and the user can retry; drivers treat "already gone" as success.
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    // Ownership is enforced by the user-scoped lookup — a caller can only
    // delete their own upload.
    const row = getUploadForReap(req.user!.id, id);
    if (!row) {
      res.status(404).json({ error: 'not found' });
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
  }),
);

export default router;
