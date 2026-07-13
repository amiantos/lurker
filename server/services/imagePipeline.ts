// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import fs from 'node:fs';
import sharp, { type Metadata } from 'sharp';
import { canScrubInPlace, scrubMetadata } from './metadataScrub.js';

const THUMB_SIZE = 128;

interface FormatInfo {
  mime: string;
  ext: string;
}

// Map sharp's `format` name to a canonical mime + filename extension. Used so
// the provider gets a filename whose extension matches the bytes regardless of
// what the client claimed in the multipart upload.
const FORMAT_INFO: Record<string, FormatInfo> = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  gif: { mime: 'image/gif', ext: 'gif' },
  webp: { mime: 'image/webp', ext: 'webp' },
  avif: { mime: 'image/avif', ext: 'avif' },
  heif: { mime: 'image/heif', ext: 'heic' },
  tiff: { mime: 'image/tiff', ext: 'tiff' },
  svg: { mime: 'image/svg+xml', ext: 'svg' },
};

export interface OptimizeResult {
  buffer: Buffer;
  mime: string;
  ext: string;
  width: number | null;
  height: number | null;
  byteSize: number;
  animated: boolean;
}

export function extensionFor(mime: string, fallback = 'bin'): string {
  const entry = Object.values(FORMAT_INFO).find((v) => v.mime === mime);
  return entry?.ext || fallback;
}

// Optimize a static image (resize longest edge to maxDim, re-encode JPEG).
// Animated images (sharp.metadata.pages > 1) bypass the resize/re-encode and
// are returned verbatim, which is a hard requirement so reaction GIFs / animated
// WebP / APNG don't lose animation on the way through Lurker.
// `input` is a path (an upload's temp file) or a Buffer. sharp accepts either, so
// the image path never has to read a file into the heap just to hand it over; the
// scrub/passthrough branches below do read the bytes, but only after sharp has
// confirmed it's an image, which the size cap already bounds.
export async function optimize(
  input: Buffer | string,
  {
    maxDim,
    quality,
    rasterOnly = false,
  }: { maxDim: number; quality: number; rasterOnly?: boolean },
): Promise<OptimizeResult> {
  // Only the passthrough/scrub branches need the bytes in memory; the resize path
  // hands the path straight to sharp. Read lazily so an ordinary image upload
  // never materializes its original file in the heap.
  const readInput = async (): Promise<Buffer> =>
    typeof input === 'string' ? fs.promises.readFile(input) : input;

  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch (cause) {
    const err = new Error(
      `unable to read image: ${(cause as Error).message || String(cause)}`,
    ) as Error & { code: string };
    err.code = 'UNSUPPORTED_FORMAT';
    throw err;
  }
  const fmt = meta.format ? FORMAT_INFO[meta.format] : undefined;
  if (!fmt) {
    const err = new Error(`unsupported image format: ${meta.format || 'unknown'}`) as Error & {
      code: string;
    };
    err.code = 'UNSUPPORTED_FORMAT';
    throw err;
  }

  const animated = (meta.pages || 1) > 1;
  if (animated) {
    // Passthrough keeps frames intact but must still honor "strip metadata":
    // animated WebP/APNG can carry GPS EXIF. Scrub in-container (no re-encode)
    // for the formats we can do surgically.
    if (canScrubInPlace(meta.format)) {
      const scrubbed = scrubMetadata(await readInput(), meta.format);
      return {
        buffer: scrubbed,
        mime: fmt.mime,
        ext: fmt.ext,
        width: meta.width || null,
        height: meta.height || null,
        byteSize: scrubbed.length,
        animated: true,
      };
    }

    // No surgical scrubber for this container (multi-page TIFF, animated
    // AVIF/HEIF). Re-encode to strip metadata rather than leak it — prefer
    // keeping the animation, and only if the codec can't round-trip do we fall
    // through to the static single-frame encode below. Either way the metadata
    // is gone; we never pass an un-scrubbed image through.
    try {
      const out = await sharp(input, { animated: true })
        .toFormat(meta.format)
        .toBuffer({ resolveWithObject: true });
      return {
        buffer: out.data,
        mime: fmt.mime,
        ext: fmt.ext,
        width: meta.width || null,
        height: meta.height || null,
        byteSize: out.data.length,
        animated: true,
      };
    } catch {
      // Codec can't re-encode animated — fall through to the static path, which
      // flattens to a metadata-free JPEG first frame. Degraded but never leaks.
    }
  }

  // SVG is a static vector — we pass it through unchanged. sharp can rasterize
  // it but doing so silently strips interactivity and inflates the byte size.
  if (meta.format === 'svg') {
    // The hosted (node) service stores raster images + .txt only: serving a
    // user-uploaded SVG from the operator's CDN domain is a stored-XSS / abuse
    // vector. Reject via the same UNSUPPORTED_FORMAT path the route already maps
    // to a 415. Standalone keeps the passthrough below.
    if (rasterOnly) {
      const err = new Error('SVG uploads are not supported') as Error & { code: string };
      err.code = 'UNSUPPORTED_FORMAT';
      throw err;
    }
    // Strip <metadata>/comments from the vector without rasterizing it.
    const scrubbed = scrubMetadata(await readInput(), meta.format);
    return {
      buffer: scrubbed,
      mime: fmt.mime,
      ext: fmt.ext,
      width: meta.width || null,
      height: meta.height || null,
      byteSize: scrubbed.length,
      animated: false,
    };
  }

  const out = await sharp(input)
    .rotate()
    .resize({
      width: maxDim,
      height: maxDim,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: out.data,
    mime: 'image/jpeg',
    ext: 'jpg',
    width: out.info.width,
    height: out.info.height,
    byteSize: out.data.length,
    animated: false,
  };
}

export async function thumbnail(input: Buffer | string): Promise<Buffer> {
  // Force first frame for animated inputs; cover-crop to a square JPEG.
  return sharp(input, { animated: false })
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 80 })
    .toBuffer();
}
