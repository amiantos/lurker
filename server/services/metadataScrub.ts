// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Frame-preserving metadata scrub for the image-pipeline passthrough paths
// (animated raster + SVG). The static-raster path already drops EXIF/GPS as a
// side effect of the sharp re-encode, but animated images (pages > 1) and
// standalone SVG pass through byte-for-byte and would otherwise keep any
// embedded EXIF/XMP/GPS. Animated WebP and APNG in particular can carry GPS
// EXIF, so "we strip metadata to protect your privacy" must hold for them too.
//
// This is deliberately container surgery, NOT a decode + re-encode: we drop the
// metadata chunks and leave every frame's pixel data untouched, so animation and
// quality are preserved exactly. Every scrubber is fail-safe — if the bytes look
// malformed or unexpected in any way, it returns the input unchanged rather than
// risk corrupting a valid upload. A scrub that can't run is a privacy miss; a
// scrub that corrupts frames is data loss, and the latter is worse.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG ancillary chunks that carry user metadata. Frame/structural chunks
// (IHDR, PLTE, IDAT, IEND, acTL, fcTL, fdAT, tRNS) and colour-management chunks
// (iCCP, sRGB, gAMA, cHRM) are kept so rendering and animation are unaffected.
const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

// The formats we can scrub surgically (in-container, no re-encode). sharp
// format names. Anything outside this set has no targeted scrubber, so a
// passthrough of it must be metadata-stripped some other way (e.g. re-encode).
const SURGICAL_FORMATS = new Set(['webp', 'png', 'gif', 'svg']);

/** Whether scrubMetadata has an in-place scrubber for this sharp format name. */
export function canScrubInPlace(format: string | undefined): boolean {
  return format !== undefined && SURGICAL_FORMATS.has(format);
}

/**
 * Strip embedded metadata from an image without recompressing or de-animating
 * it. `format` is sharp's format name (`webp` | `png` | `gif` | `svg`, …).
 * Formats we don't have a targeted scrubber for are returned unchanged.
 */
export function scrubMetadata(buffer: Buffer, format: string | undefined): Buffer {
  try {
    switch (format) {
      case 'webp':
        return scrubWebp(buffer);
      case 'png': // also covers APNG (animated PNG shares the container)
        return scrubPng(buffer);
      case 'gif':
        return scrubGif(buffer);
      case 'svg':
        return scrubSvg(buffer);
      default:
        return buffer;
    }
  } catch {
    // Any unforeseen parsing error → hand back the original bytes untouched.
    return buffer;
  }
}

// ---- WebP (RIFF container) -------------------------------------------------
// Structure: 'RIFF' <uint32 LE size> 'WEBP' then a sequence of chunks, each
// 'FourCC' <uint32 LE size> <payload> plus a pad byte when size is odd. EXIF and
// XMP live in dedicated 'EXIF' / 'XMP ' chunks; the VP8X header chunk carries
// flag bits announcing their presence. We drop the metadata chunks and clear the
// corresponding VP8X flags; every frame chunk (VP8/VP8L/ANIM/ANMF/ALPH) is kept.
function scrubWebp(buffer: Buffer): Buffer {
  if (buffer.length < 12) return buffer;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF') return buffer;
  if (buffer.toString('latin1', 8, 12) !== 'WEBP') return buffer;

  const VP8X_EXIF_FLAG = 0x08;
  const VP8X_XMP_FLAG = 0x04;

  const kept: Buffer[] = [buffer.subarray(0, 12)];
  let changed = false;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const fourcc = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) return buffer; // truncated chunk → bail
    // Chunks are padded to an even boundary; the pad byte may be absent on the
    // final chunk of some encoders, so clamp to the buffer end.
    const next = Math.min(dataStart + size + (size % 2), buffer.length);

    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      changed = true; // drop it
    } else if (fourcc === 'VP8X' && size >= 1) {
      const flags = buffer[dataStart];
      const cleared = flags & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      if (cleared !== flags) {
        const chunk = Buffer.from(buffer.subarray(offset, next));
        chunk[8] = cleared; // byte 0 of the payload = offset 8 within the chunk
        kept.push(chunk);
        changed = true;
      } else {
        kept.push(buffer.subarray(offset, next));
      }
    } else {
      kept.push(buffer.subarray(offset, next));
    }
    offset = next;
  }

  if (!changed) return buffer;
  const out = Buffer.concat(kept);
  out.writeUInt32LE(out.length - 8, 4); // fix the RIFF payload size
  return out;
}

// ---- PNG / APNG ------------------------------------------------------------
// Structure: 8-byte signature then chunks of <uint32 BE length> <4-byte type>
// <payload> <uint32 BE CRC>. Metadata lives in ancillary text/time/EXIF chunks;
// we drop those and keep every structural and frame chunk byte-for-byte (kept
// chunks retain their original CRCs, so nothing needs recomputing).
function scrubPng(buffer: Buffer): Buffer {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return buffer;

  const kept: Buffer[] = [buffer.subarray(0, 8)];
  let changed = false;
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + len; // 4 len + 4 type + len + 4 CRC
    if (chunkEnd > buffer.length) return buffer; // truncated chunk → bail

    if (PNG_METADATA_CHUNKS.has(type)) {
      changed = true; // drop it
    } else {
      kept.push(buffer.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
    if (type === 'IEND') break; // ignore any trailing bytes past the end chunk
  }

  return changed ? Buffer.concat(kept) : buffer;
}

// ---- GIF -------------------------------------------------------------------
// GIF carries no standard EXIF, but Comment Extensions (0x21 0xFE) hold
// arbitrary text and an XMP payload rides in an Application Extension
// (0x21 0xFF, app-id "XMP DataXMP"). We drop those two and keep everything else
// — crucially the NETSCAPE looping extension, graphic-control extensions and all
// image data — so animation and timing survive untouched.
function scrubGif(buffer: Buffer): Buffer {
  if (buffer.length < 13) return buffer;
  const sig = buffer.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return buffer;

  // Logical Screen Descriptor: the packed byte at offset 10 says whether a
  // Global Colour Table follows and how big it is.
  const packed = buffer[10];
  const gctSize = (packed & 0x80) !== 0 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  let p = 13 + gctSize;
  if (p > buffer.length) return buffer;

  // Walk a run of size-prefixed data sub-blocks; return the offset just past the
  // 0x00 terminator, or -1 if the bytes run out first.
  const skipSubBlocks = (start: number): number => {
    let q = start;
    for (;;) {
      if (q >= buffer.length) return -1;
      const blockSize = buffer[q];
      if (blockSize === 0) return q + 1;
      q += 1 + blockSize;
    }
  };

  const kept: Buffer[] = [buffer.subarray(0, p)]; // header + LSD + GCT
  let changed = false;

  while (p < buffer.length) {
    const marker = buffer[p];

    if (marker === 0x3b) {
      // Trailer — copy it and stop; anything after is trailing junk.
      kept.push(buffer.subarray(p, p + 1));
      p += 1;
      break;
    }

    if (marker === 0x2c) {
      // Image Descriptor: 10-byte header, optional Local Colour Table, then an
      // LZW-minimum-code-size byte and the image data sub-blocks.
      if (p + 10 > buffer.length) return buffer;
      const lpacked = buffer[p + 9];
      const lctSize = (lpacked & 0x80) !== 0 ? 3 * (1 << ((lpacked & 0x07) + 1)) : 0;
      const dataStart = p + 10 + lctSize + 1; // +1 skips the LZW min-code byte
      const end = skipSubBlocks(dataStart);
      if (end < 0) return buffer;
      kept.push(buffer.subarray(p, end));
      p = end;
      continue;
    }

    if (marker === 0x21) {
      // Extension: 0x21 <label> then data sub-blocks.
      if (p + 2 > buffer.length) return buffer;
      const label = buffer[p + 1];
      const dataStart = p + 2;
      const end = skipSubBlocks(dataStart);
      if (end < 0) return buffer;

      const isComment = label === 0xfe;
      const isXmp =
        label === 0xff &&
        buffer[dataStart] === 0x0b &&
        buffer.toString('latin1', dataStart + 1, dataStart + 12) === 'XMP DataXMP';

      if (isComment || isXmp) {
        changed = true; // drop it
      } else {
        kept.push(buffer.subarray(p, end));
      }
      p = end;
      continue;
    }

    return buffer; // unexpected marker → bail rather than risk corruption
  }

  return changed ? Buffer.concat(kept) : buffer;
}

// ---- SVG -------------------------------------------------------------------
// SVG is XML text. Editors (Inkscape, Illustrator) embed author, title, and RDF
// document metadata in <metadata> elements and XML comments. Strip both; leave
// the drawing untouched. This runs only on the standalone passthrough (hosted
// rejects SVG outright).
function scrubSvg(buffer: Buffer): Buffer {
  const text = buffer.toString('utf8');
  const scrubbed = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(\w+:)?metadata\b[^>]*\/>/gi, '')
    .replace(/<(\w+:)?metadata\b[\s\S]*?<\/(\w+:)?metadata\s*>/gi, '');
  return scrubbed === text ? buffer : Buffer.from(scrubbed, 'utf8');
}
