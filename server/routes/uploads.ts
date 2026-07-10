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
  UploaderUnavailableError,
  UploaderNotConfiguredError,
} from '../services/uploadProviders/resolve.js';
import type { UploadListRow } from '../db/uploadHistory.js';
import { insertUpload, listUploads, getThumbnail, deleteUpload } from '../db/uploadHistory.js';
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
      let resolved;
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
            thumbnailUrl = tRes.url;
            thumbnailBlob = null;
          }
        } catch {
          // keep thumbnailBlob — fall back to the inline BLOB
        }
      }

      const id = insertUpload(req.user!.id, {
        provider: resolved.driverId,
        url: result.url,
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
        url: result.url,
        thumb_url: thumbnailUrl,
        mime: outMime,
        byte_size: outByteSize,
        width: outWidth,
        height: outHeight,
      });

      res.json({ id, url: result.url, ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}) });
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
  const ok = deleteUpload(req.user!.id, Number(req.params.id));
  if (!ok) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ok: true });
});

export default router;
