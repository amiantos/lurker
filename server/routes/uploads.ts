// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { getUserSettings } from '../db/settings.js';
import { defaultsAsObject } from '../services/settingsRegistry.js';
import * as imagePipeline from '../services/imagePipeline.js';
import { driverIds } from '../services/uploadProviders/index.js';
import type { ContentClass } from '../services/uploadProviders/index.js';
import {
  resolveUploader,
  loadDriverForRef,
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

// multer needs configuring up-front, before we know the effective per-uploader
// cap. Use a generous hard ceiling (200 MB, the registry max) so multer never
// rejects below the real cap; the handler enforces the resolved cap.
const HARD_BYTE_CEILING = 200 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: HARD_BYTE_CEILING, files: 1 },
});

router.post(
  '/',
  upload.single('image'),
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'no file uploaded' });
        return;
      }

      // Resolve the configured uploader. Every isNodeMode() branch the old route
      // made (which provider, whose credentials, which caps, SVG policy, thumbnail
      // strategy) is now derived from the resolved uploader's driver + policy.
      let resolved: ResolvedUploader;
      try {
        resolved = resolveUploader({
          userId: req.user!.id,
          isAdmin: req.user!.role === 'admin',
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
      const maxMb =
        resolved.policy.maxMb ?? (Number(settings['uploads.image.max_upload_mb']) || 25);
      if (req.file.size > maxMb * 1024 * 1024) {
        res.status(413).json({ error: `file exceeds ${maxMb} MB` });
        return;
      }

      // Long-message → .txt upload bypasses the sharp pipeline: the bytes go
      // straight through with a .txt extension and no thumbnail.
      const isText = req.file.mimetype === 'text/plain';
      const contentClass: ContentClass = isText ? 'text' : 'image';

      // Validate stage: the resolved driver must accept this content class. In P0
      // every driver accepts image + text, so this never rejects — but it makes
      // acceptsContentClasses a real gate (defense-in-depth) once binary-capable
      // drivers land, rather than a declared-but-unused capability.
      if (!resolved.driver.capabilities.acceptsContentClasses.includes(contentClass)) {
        res.status(415).json({ error: `this uploader does not accept ${contentClass} files` });
        return;
      }

      let outBuffer: Buffer;
      let outMime: string;
      let outExt: string;
      let outByteSize: number;
      let outWidth: number | null = null;
      let outHeight: number | null = null;
      let thumb: Buffer | null = null;

      if (isText) {
        outBuffer = req.file.buffer;
        outMime = 'text/plain';
        outExt = 'txt';
        outByteSize = req.file.size;
      } else {
        // imagePipeline is an untyped JS module — any is unavoidable here
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let optimized: any;
        try {
          optimized = await imagePipeline.optimize(req.file.buffer, {
            maxDim:
              resolved.policy.maxDim ?? (Number(settings['uploads.image.max_dimension']) || 2048),
            quality: resolved.policy.quality ?? (Number(settings['uploads.image.quality']) || 85),
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
        thumb = (await imagePipeline.thumbnail(req.file.buffer)) as Buffer | null;
        outBuffer = optimized.buffer as Buffer;
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
          outBuffer,
          { filename, mime: outMime, contentClass },
          resolved.driverConfig,
        );
      } catch (err) {
        const e = err as { code?: string; message?: string };
        const status = e.code === 'PROVIDER_AUTH' ? 401 : e.code === 'PROVIDER_CONFIG' ? 400 : 502;
        res.status(status).json({ error: e.message, provider: resolved.driverId });
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
          const tRes = await resolved.driver.upload(
            thumb,
            { filename: 'thumb.jpg', mime: 'image/jpeg', contentClass: 'image', kind: 'thumb' },
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

      res.json({ id, url: mainUrl, ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}) });
    } catch (err) {
      next(err);
    }
  }),
);

router.get('/', (req: Request, res: Response) => {
  const before = req.query.before ? Number(req.query.before) : null;
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  const rows: UploadListRow[] = listUploads(req.user!.id, { before, limit });
  res.json({
    items: rows.map((r) => {
      const { has_thumbnail, thumbnail_url, removed, ...rest } = r;
      // A moderated-away upload keeps its row as a tombstone, but its bytes are
      // gone — advertise no thumbnail so the client renders the tombstone.
      if (removed) return { ...rest, removed: true };
      // Prefer a remote CDN thumbnail; otherwise fall back to the local
      // BLOB-serving route when an inline thumbnail exists.
      const thumb = thumbnail_url || (has_thumbnail ? `/api/uploads/${r.id}/thumb` : null);
      return thumb ? { ...rest, thumbnail_url: thumb } : rest;
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
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(row.thumbnail);
});

router.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  // Capture the delete handle before dropping the row so we can reap the bytes
  // for drivers that own their storage (local disk). Ownership is enforced by the
  // user-scoped lookup — a caller can only reap their own upload.
  const reap = getUploadForReap(req.user!.id, id);
  const ok = deleteUpload(req.user!.id, id);
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Best-effort, fire-and-forget: a failed unlink leaves an orphan file but must
  // never fail the user's delete or block the response. Non-owning drivers
  // (x0/catbox/hoarder) don't advertise delete, so this is a no-op for them.
  if (reap && reap.ref && reap.uploader_config_id != null) {
    void reapUploadBytes(reap.uploader_config_id, reap.ref);
  }
  res.json({ ok: true });
});

async function reapUploadBytes(configId: number, ref: string): Promise<void> {
  try {
    const loaded = loadDriverForRef(configId);
    if (!loaded || !loaded.driver.capabilities.supportsDelete || !loaded.driver.delete) return;
    await loaded.driver.delete(ref, loaded.driverConfig);
  } catch (err) {
    console.error('[lurker] upload byte reap failed:', err);
  }
}

export default router;
