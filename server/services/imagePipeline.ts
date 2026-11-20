// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import fs from 'node:fs';
import sharp, { type Metadata, type Sharp } from 'sharp';
import { canScrubInPlace, scrubMetadata } from './metadataScrub.js';

// 512, not 128. The uploads browser (#547) is a gallery you browse BY thumbnail, and
// at 128px that doesn't work — you squint. Its tiles are ~180px, which is 360 device
// pixels on a 2x display, so the source has to be at least that to stay crisp; 512
// covers it with headroom for 3x and for larger tiles later.
//
// Measured on a real photo, as WebP: 128px = 2.3 KB, 256px = 4.5 KB, 512px = 9.3 KB.
// Seven kilobytes per upload is not a number worth designing a UI around.
//
// ⚠ Only NEW uploads get it. Existing rows keep the thumb they were made with and we
// can't regenerate them — the originals live at the provider, not here — so the
// gallery is mixed-sharpness until it churns. That's the accepted cost; the
// alternative was designing every tile around the smallest thumb we ever wrote.
const THUMB_SIZE = 512;

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

// The formats the static path will ENCODE to (a subset of the formats it can
// read). webp is the default; jpeg is the escape hatch for an ancient client or
// an upload host that mangles webp (`uploads.image.format`, #560).
export type OutputFormat = 'webp' | 'jpeg';

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

// `quality` is a single 0–100 perceptual scale handed to whichever encoder the
// format selects. The two scales are NOT identical — libwebp's 85 is not
// mozjpeg's 85 — but both mean "higher = better and bigger", which is what the
// setting promises, and one slider beats two knobs nobody touches.
function encode(pipeline: Sharp, format: OutputFormat, quality: number): Sharp {
  return format === 'jpeg' ? pipeline.jpeg({ quality, mozjpeg: true }) : pipeline.webp({ quality });
}

/** An image sharp could not read or could not decode. The route answers it 415. */
function unreadable(cause: unknown): Error & { code: string } {
  // Only the last line: libvips puts every seek it retried in front of the reason,
  // and this message is shown to the user.
  const detail = ((cause as Error)?.message || String(cause)).trim().split('\n').pop();
  const err = new Error(`unable to read image: ${detail}`) as Error & { code: string };
  err.code = 'UNSUPPORTED_FORMAT';
  return err;
}

/**
 * Run a sharp pipeline to its output, with a failure to DECODE answered the same way
 * as a failure to read the header.
 *
 * ⚠ metadata() succeeding promises nothing about the pixels. It reads a header; the
 * pipeline is what decodes, and that is where a truncated photo, a damaged one, or a
 * codec this build of libvips has no decoder for finally fails. Unguarded, that
 * throw is not an UNSUPPORTED_FORMAT, so the route had nothing to map it to and the
 * user got a 500 "internal error" for what is a bad file.
 */
async function decoded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw unreadable(cause);
  }
}

// sharp's reading of an image, and its format; UNSUPPORTED_FORMAT when it
// can't read one, or reads one Lurker doesn't take.
async function readImage(input: Buffer | string): Promise<{ meta: Metadata; fmt: FormatInfo }> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch (cause) {
    throw unreadable(cause);
  }
  const fmt = meta.format ? FORMAT_INFO[meta.format] : undefined;
  if (!fmt) {
    const err = new Error(`unsupported image format: ${meta.format || 'unknown'}`) as Error & {
      code: string;
    };
    err.code = 'UNSUPPORTED_FORMAT';
    throw err;
  }
  return { meta, fmt };
}

// Optimize a static image (resize longest edge to maxDim, re-encode to `format`).
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
    format = 'webp',
    rasterOnly = false,
  }: { maxDim: number; quality: number; format?: OutputFormat; rasterOnly?: boolean },
): Promise<OptimizeResult> {
  // Only the passthrough/scrub branches need the bytes in memory; the resize path
  // hands the path straight to sharp. Read lazily so an ordinary image upload
  // never materializes its original file in the heap.
  const readInput = async (): Promise<Buffer> =>
    typeof input === 'string' ? fs.promises.readFile(input) : input;

  const { meta, fmt } = await readImage(input);

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
      // flattens to a metadata-free first frame. Degraded but never leaks.
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

  // ⚠ The output format, mime and ext MUST agree — they used to be three
  // hardcoded jpeg constants that could drift. Pick the format once and derive
  // the other two from FORMAT_INFO.
  const outFmt = FORMAT_INFO[format];
  const out = await decoded(() =>
    encode(
      sharp(input).rotate().resize({
        width: maxDim,
        height: maxDim,
        fit: 'inside',
        withoutEnlargement: true,
      }),
      format,
      quality,
    ).toBuffer({ resolveWithObject: true }),
  );

  return {
    buffer: out.data,
    mime: outFmt.mime,
    ext: outFmt.ext,
    width: out.info.width,
    height: out.info.height,
    byteSize: out.data.length,
    animated: false,
  };
}

export async function thumbnail(
  input: Buffer | string,
  { format = 'webp', quality = 80 }: { format?: OutputFormat; quality?: number } = {},
): Promise<Buffer> {
  // Force first frame for animated inputs; cover-crop to a square. Follows the
  // same format as the full image: a jpeg thumbnail of a transparent PNG is
  // black-backgrounded, which is the most visible face of the alpha bug.
  return decoded(() =>
    encode(
      sharp(input, { animated: false })
        .rotate()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' }),
      format,
      quality,
    ).toBuffer(),
  );
}

// Avatars (#1189) are drawn small, but the profile modal and a 3x screen draw
// them at a few hundred device pixels. The upload is the original, the one copy
// that can't be made bigger later, so a still keeps 512 of headroom; the decoder
// that resizes every avatar Lurker shows serves a smaller copy of it.
const AVATAR_SIZE = 512;
// ⚠ An animated one is cut to lurker-previews' AVATAR_SIZE (server/avatar.ts) instead.
// The decoder's animated budget counts frames × pixels, so a 512 px GIF would fall
// to its first frame there after ~76 frames, a 256 px one after ~305.
const ANIMATED_AVATAR_SIZE = 256;

// An image made an avatar: cropped to a square, at most AVATAR_SIZE on a side
// (ANIMATED_AVATAR_SIZE when it keeps its frames), never enlarged. A still keeps its busiest region (sharp's attention
// strategy); an animated GIF or WebP keeps its frames, cropped about the
// centre — sharp has no strategy for a multi-page image — and re-encodes to
// itself, which drops its metadata. One sharp can't crop animated is
// flattened to its first frame, as optimize() does. An SVG is rasterised:
// other clients draw an avatar as a bitmap.
export async function avatar(
  input: Buffer | string,
  { quality, format = 'webp' }: { quality: number; format?: OutputFormat },
): Promise<OptimizeResult> {
  const { meta, fmt } = await readImage(input);
  const width = meta.width || 0;
  const height = meta.pageHeight || meta.height || 0;
  const vector = meta.format === 'svg';
  // An SVG renders at 72 dpi: enough density for the short side to fill the square.
  const density = vector
    ? Math.min(2400, Math.max(72, (72 * AVATAR_SIZE) / Math.max(1, Math.min(width, height))))
    : undefined;
  const side = vector ? AVATAR_SIZE : Math.max(1, Math.min(AVATAR_SIZE, width, height));

  if ((meta.pages || 1) > 1 && (meta.format === 'gif' || meta.format === 'webp')) {
    const frameSide = Math.min(side, ANIMATED_AVATAR_SIZE);
    try {
      const out = await sharp(input, { animated: true })
        .resize(frameSide, frameSide, { fit: 'cover', position: 'centre' })
        .toFormat(meta.format, meta.format === 'webp' ? { quality } : {})
        .toBuffer();
      return {
        buffer: out,
        mime: fmt.mime,
        ext: fmt.ext,
        width: frameSide,
        height: frameSide,
        byteSize: out.length,
        animated: true,
      };
    } catch {
      // Flattened below, like a format with no animated encoder.
    }
  }

  const outFmt = FORMAT_INFO[format];
  // rotate() before the crop: the square is cut from the image as it's seen,
  // EXIF orientation applied. A rotated still's sides swap, but the short one
  // is the same either way.
  const out = await decoded(() =>
    encode(
      sharp(input, density ? { density } : {})
        .rotate()
        .resize(side, side, { fit: 'cover', position: 'attention' }),
      format,
      quality,
    ).toBuffer(),
  );
  return {
    buffer: out,
    mime: outFmt.mime,
    ext: outFmt.ext,
    width: side,
    height: side,
    byteSize: out.length,
    animated: false,
  };
}
