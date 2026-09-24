// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// One upload, from a file already on disk to a stored, recorded URL: resolve the
// uploader, check the cap, classify, run the pipeline, hand it to the driver,
// thumbnail, record. Both upload routes share it: POST /api/uploads (the web and
// iOS apps, multipart) and the bouncer's FILEHOST route (IRC clients, a raw
// body). A failure the caller should answer is an UploadRequestError carrying
// its status; anything else is a bug and propagates.

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../utils/dataDir.js';
import { randomId } from './uploadProviders/objectKey.js';
import { bufferSource, fileSource, type UploadSource } from './uploadProviders/source.js';
import {
  effectiveSettings,
  userCapBytes,
  clampUploadCapBytes,
  formatCapMb,
} from './uploadLimits.js';
import * as imagePipeline from './imagePipeline.js';
import { thumbnailFormat } from './thumbnailFormat.js';
import { makeUploadProgress } from './uploadProgress.js';
import { classifyUpload, UnsupportedTypeError, type Classification } from './contentClass.js';
import { scrubMediaFile, MediaScrubError } from './mediaScrub.js';
import {
  resolveUploader,
  deletableWith,
  UploaderUnavailableError,
  UploaderNotConfiguredError,
  type ResolvedUploader,
} from './uploadProviders/resolve.js';
import { insertUpload } from '../db/uploadHistory.js';
import { reportUploadSoon } from './moderationReport.js';

// Uploads land in a temp file, never in the heap. multer's memoryStorage used to
// hold the whole file, and the drivers then copied it again (and fetch copied it a
// third time) — a 200 MB upload cost ~1 GB of RSS. See services/uploadProviders/
// source.ts for the measurements. Everything downstream takes an UploadSource.
// 0o700: an in-flight upload is the user's private data and must not be readable
// by other local users on a shared host. Matches routes/exports.ts's staged-import
// posture.
export const UPLOAD_TMP_DIR = path.join(resolveDataDir(), 'tmp', 'uploads');
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 });

/** A fresh temp file name for an upload. The `up-` prefix is what
 *  sweepTempUploads (routes/uploads.ts) clears after a crash. */
export function uploadTempName(): string {
  return `up-${randomId()}`;
}

/** A failure to answer with `status`; `extra` rides along in a JSON body. */
export class UploadRequestError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'UploadRequestError';
    this.status = status;
    this.extra = extra;
  }
}

export interface UploadInput {
  userId: number;
  isAdmin: boolean;
  /** The upload's temp file. The caller removes it afterwards (the local driver
   *  may already have renamed it away). */
  tempPath: string;
  size: number;
  /** The MIME the client claimed. Classification reads the bytes, not this. */
  claimedMime: string;
  originalName: string;
  /** A per-upload uploader override, or null for the user's default. */
  requestedUploaderId: number | null;
  progressToken: string | null;
  /** The instance's public origin, asked for only when a local upload's
   *  root-relative URL needs absolutizing. '' leaves the URL relative. */
  baseUrl: () => string;
}

export interface UploadOutput {
  id: number;
  url: string;
  mime: string;
  can_delete: boolean;
  thumbnail_url?: string;
}

// Map a driver error onto an HTTP status. PROVIDER_AUTH deliberately does NOT
// become 401: that's the provider rejecting the uploader's stored credential,
// not the caller's Lurker session — and the client's api() treats any 401 as a
// dead session and hard-reloads to the login page. Upstream failures of every
// kind are 502; only a config the user can fix themselves is a 400.
export function providerErrorStatus(e: { code?: string }): number {
  return e.code === 'PROVIDER_CONFIG' ? 400 : 502;
}

/** Absolutize a driver result URL. Drivers that store remotely already return an
 *  absolute URL; the local driver returns a root-relative path we prefix with the
 *  instance's public base, unless its own public_base_url made it absolute. */
function absolutizeUrl(url: string, storesRemotely: boolean, baseUrl: () => string): string {
  if (storesRemotely || !url.startsWith('/')) return url;
  const base = baseUrl();
  return base ? base + url : url;
}

export async function processUpload(input: UploadInput): Promise<UploadOutput> {
  // No control characters in the name: it goes into a provider's multipart
  // header and the uploads list, and a `filename*` can percent-encode a CR or LF.
  const originalName = (input.originalName || '').replace(/\p{Cc}/gu, '');

  // Resolve the configured uploader. Every isNodeMode() branch the old route
  // made (which provider, whose credentials, which caps, SVG policy, thumbnail
  // strategy) is now derived from the resolved uploader's driver + policy.
  let resolved: ResolvedUploader;
  try {
    resolved = resolveUploader({
      userId: input.userId,
      isAdmin: input.isAdmin,
      requestedId: input.requestedUploaderId,
    });
  } catch (err) {
    // A locked instance default that the operator hasn't configured →
    // server-side 503 (was: isNodeMode() && !nodeUploadConfigured()).
    if (err instanceof UploaderNotConfiguredError) throw new UploadRequestError(503, err.message);
    // No usable uploader for this account → ask the user to pick one.
    if (err instanceof UploaderUnavailableError) throw new UploadRequestError(400, err.message);
    throw err;
  }

  // Correlation token for the progress events (#545). Absent → makeUploadProgress
  // returns a no-op and the client falls back to an indeterminate label; progress
  // must never be a precondition for uploading.
  const progress = makeUploadProgress(input.userId, input.progressToken, resolved.driver.label);

  const settings = effectiveSettings(input.userId);
  // Size cap: operator-baked policy (hosted locked uploader) wins; otherwise
  // the user's own setting. A tenant can't lift a policy cap because the
  // policy is on the instance row, not their settings. Clamped to the
  // instance's transport ceiling last (#627), so a body the proxy in front of
  // us would have rejected anyway is refused with a real 413 rather than an
  // edge-level connection reset.
  const policyMb = resolved.policy.maxMb;
  const maxBytes = clampUploadCapBytes(
    policyMb == null ? userCapBytes(settings) : policyMb * 1024 * 1024,
  );
  if (input.size > maxBytes) {
    throw new UploadRequestError(413, `file exceeds ${formatCapMb(maxBytes)} MB`);
  }

  // Classify from the MAGIC BYTES, never the client's claimed MIME (#515). The
  // claim used to decide this, which was survivable only while the alternative
  // branch was the image pipeline — the moment a class means "passthrough", a
  // claimed MIME is a route around imagePipeline.optimize(), and that's where
  // the EXIF scrub lives. See services/contentClass.ts.
  let classified: Classification;
  try {
    // The filename rides along only so a `.md`/`.json` keeps its name on platforms
    // that register no MIME for it (#788). It cannot widen the accepted set, and it
    // is not where the served extension comes from — see contentClass.ts.
    classified = await classifyUpload(input.tempPath, input.claimedMime, originalName);
  } catch (err) {
    if (err instanceof UnsupportedTypeError) throw new UploadRequestError(415, err.message);
    throw err;
  }
  const contentClass = classified.contentClass;

  // Validate stage: the resolved driver must accept this class. This is what
  // makes hosted (whose dropper takes images + text only) refuse media, without
  // a policy flag anywhere.
  if (!resolved.driver.capabilities.acceptsContentClasses.includes(contentClass)) {
    throw new UploadRequestError(
      415,
      `${resolved.driver.label} does not accept ${contentClass} files`,
    );
  }

  let outSource: UploadSource;
  let outMime: string;
  let outExt: string;
  let outByteSize: number;
  let outWidth: number | null = null;
  let outHeight: number | null = null;
  let thumb: Buffer | null = null;

  // Everything from here to the driver call is the pipeline: the sharp re-encode
  // for images, the in-place metadata scrub for media. Both are native one-shots
  // with no seam to count, so this phase is announced but not measured.
  progress.processing();

  if (contentClass === 'text' || contentClass === 'media') {
    // Passthrough: the bytes go out of the temp file exactly as they came in.
    // Nothing reads them into memory — the driver streams the file (#543).
    if (contentClass === 'media') {
      // …except the metadata, which is stripped in place first. A phone's MP4
      // carries GPS in moov/udta; passing it through untouched would re-open
      // exactly the leak #516 closed for photos. The scrub is size-preserving,
      // so the input size stays correct.
      try {
        await scrubMediaFile(input.tempPath, classified.mime);
      } catch (err) {
        if (err instanceof MediaScrubError) throw new UploadRequestError(415, err.message);
        throw err;
      }
    }
    // Re-stat rather than reuse the input size. The scrub is size-preserving by
    // construction — that's the whole reason boxes are retyped to `free` instead
    // of removed — but this size becomes the upload's Content-Length, and a
    // wrong one truncates the body or hangs the request. Don't make a network
    // framing invariant depend on a promise made in another module's comment.
    const { size: bytesOnDisk } = await fs.promises.stat(input.tempPath);
    outSource = fileSource(input.tempPath, bytesOnDisk);
    outMime = classified.mime;
    outExt = classified.ext;
    outByteSize = bytesOnDisk;
  } else {
    // The output format is the user's, with no policy override: unlike maxDim/
    // quality/maxMb it isn't a cost lever the operator needs to bake, and the
    // hosted dropper accepts both webp and jpeg (#560).
    const format: imagePipeline.OutputFormat =
      settings['uploads.image.format'] === 'jpeg' ? 'jpeg' : 'webp';
    const quality = resolved.policy.quality ?? (Number(settings['uploads.image.quality']) || 85);
    let optimized: imagePipeline.OptimizeResult;
    try {
      optimized = await imagePipeline.optimize(input.tempPath, {
        maxDim: resolved.policy.maxDim ?? (Number(settings['uploads.image.max_dimension']) || 2048),
        quality,
        format,
        // SVG is rejected only where the resolved uploader's policy says so
        // (the hosted locked uploader serves raster + .txt). Self-host keeps
        // the SVG passthrough. Was: rasterOnly = isNodeMode().
        rasterOnly: resolved.policy.rasterOnly,
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'UNSUPPORTED_FORMAT') throw new UploadRequestError(415, e.message ?? '');
      throw err;
    }
    thumb = await imagePipeline.thumbnail(input.tempPath, { format });
    // The optimized image is small and bounded (resized + re-encoded), so it
    // stays a buffer — round-tripping it through another temp file would be
    // pointless I/O. The heap blowup this PR removes was the ORIGINAL bytes.
    outSource = bufferSource(optimized.buffer);
    outMime = optimized.mime;
    outExt = optimized.ext;
    outByteSize = optimized.byteSize;
    outWidth = optimized.width;
    outHeight = optimized.height;
  }

  const baseName = originalName.replace(/\.[^.]+$/, '') || `upload-${Date.now()}`;
  const filename = `${baseName}.${outExt}`;

  // The slow half on a home uplink, and the half the browser is blind to. Announce
  // it before the first byte so the user learns which leg they're waiting on even
  // for a driver that reports none (`local` renames the file — no wire to count).
  progress.sending();

  // provider.upload is from an untyped JS module boundary
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  try {
    result = await resolved.driver.upload(
      outSource,
      { filename, mime: outMime, contentClass, onProgress: progress.onBytes },
      resolved.driverConfig,
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw new UploadRequestError(providerErrorStatus(e), e.message ?? '', {
      provider: resolved.driverId,
    });
  }

  const storesRemotely = resolved.driver.capabilities.storesRemotely;
  const mainUrl = absolutizeUrl(result.url as string, storesRemotely, input.baseUrl);

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
      const thumbFmt = thumbnailFormat(thumb);
      const tRes = await resolved.driver.upload(
        bufferSource(thumb),
        {
          filename: `thumb.${thumbFmt.ext}`,
          mime: thumbFmt.mime,
          contentClass: 'image',
          kind: 'thumb',
        },
        resolved.driverConfig,
      );
      if (tRes && typeof tRes.url === 'string') {
        thumbnailUrl = absolutizeUrl(tRes.url, storesRemotely, input.baseUrl);
        thumbnailBlob = null;
      }
    } catch {
      // keep thumbnailBlob — fall back to the inline BLOB
    }
  }

  const id = insertUpload(input.userId, {
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
    cell_user_id: input.userId,
    url: mainUrl,
    thumb_url: thumbnailUrl,
    mime: outMime,
    byte_size: outByteSize,
    width: outWidth,
    height: outHeight,
  });

  // Deletability is decided at capture time (decision 8): the driver returned
  // a ref only if this specific upload's bytes can be destroyed later.
  const canDelete = Boolean(result.ref) && deletableWith(resolved.driver, resolved.driverConfig);
  return {
    id,
    url: mainUrl,
    // The REAL mime, derived from the bytes — the client builds its optimistic
    // history row from this rather than from what the browser guessed, so the
    // row's type icon isn't a lie until the next refetch.
    mime: outMime,
    can_delete: canDelete,
    ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl } : {}),
  };
}
