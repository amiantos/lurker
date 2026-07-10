// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { canScrubInPlace, scrubMetadata } from './metadataScrub.js';

// ---- helpers ---------------------------------------------------------------

// Build a RIFF/WebP chunk (FourCC + LE size + payload + even-pad byte).
function webpChunk(fourcc: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(payload.length, 4);
  const parts = [head, payload];
  if (payload.length % 2 === 1) parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function buildWebp(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4); // + 'WEBP'
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

function listWebpChunks(buf: Buffer): { fourcc: string; payload: Buffer }[] {
  const out: { fourcc: string; payload: Buffer }[] = [];
  let o = 12;
  while (o + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    out.push({ fourcc, payload: buf.subarray(o + 8, o + 8 + size) });
    o = o + 8 + size + (size % 2);
  }
  return out;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  // CRC is a fixed placeholder — the scrubber copies kept chunks verbatim and
  // never recomputes or validates CRCs.
  return Buffer.concat([len, Buffer.from(type, 'latin1'), payload, Buffer.from([1, 2, 3, 4])]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function listPngChunks(buf: Buffer): string[] {
  const out: string[] = [];
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    out.push(type);
    o = o + 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

// A real 2-frame 1×1 GIF89a with a NETSCAPE looping application extension —
// same fixture the imagePipeline tests use. Exercises the full GIF walker.
const TWO_FRAME_GIF_B64 =
  'R0lGODlhAQABAIAAAP///wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAA' +
  'AQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICRAEAOw==';
const TWO_FRAME_GIF = Buffer.from(TWO_FRAME_GIF_B64, 'base64');

// Splice `ext` in just before the GIF trailer (0x3B, the final byte).
function insertBeforeTrailer(gif: Buffer, ext: Buffer): Buffer {
  return Buffer.concat([gif.subarray(0, gif.length - 1), ext, gif.subarray(gif.length - 1)]);
}

// ---- WebP ------------------------------------------------------------------

describe('scrubMetadata — WebP', () => {
  it('drops EXIF and XMP chunks and clears the VP8X flag bits, keeping frames', () => {
    // flags: EXIF(0x08) | XMP(0x04) | Animation(0x02) all set
    const vp8xPayload = Buffer.concat([Buffer.from([0x0e]), Buffer.alloc(9)]);
    const frame = Buffer.from('framebytes', 'latin1'); // stand-in VP8L payload
    const input = buildWebp([
      webpChunk('VP8X', vp8xPayload),
      webpChunk('VP8L', frame),
      webpChunk('EXIF', Buffer.from('gps-here', 'latin1')),
      webpChunk('XMP ', Buffer.from('<x:xmpmeta/>', 'latin1')),
    ]);

    const out = scrubMetadata(input, 'webp');
    const chunks = listWebpChunks(out);

    expect(chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'VP8L']);
    // Only the Animation bit survives.
    expect(chunks[0].payload[0]).toBe(0x02);
    // Frame bytes untouched.
    expect(Buffer.compare(chunks[1].payload, frame)).toBe(0);
    // RIFF size header matches the new length.
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out.toString('latin1')).not.toContain('gps-here');
  });

  it('returns the input unchanged when there is no metadata', () => {
    const input = buildWebp([
      webpChunk('VP8X', Buffer.concat([Buffer.from([0x02]), Buffer.alloc(9)])),
      webpChunk('VP8L', Buffer.from('framebytes', 'latin1')),
    ]);
    // Same reference back = provably a no-op.
    expect(scrubMetadata(input, 'webp')).toBe(input);
  });

  it('bails (returns input) on a truncated chunk', () => {
    const input = buildWebp([webpChunk('VP8L', Buffer.from('frame', 'latin1'))]);
    input.writeUInt32LE(9999, 20); // corrupt the VP8L declared size
    expect(scrubMetadata(input, 'webp')).toBe(input);
  });
});

// ---- PNG / APNG ------------------------------------------------------------

describe('scrubMetadata — PNG', () => {
  it('drops text/EXIF/time chunks and keeps structural + frame chunks', () => {
    const input = Buffer.concat([
      PNG_SIG,
      pngChunk('IHDR', Buffer.alloc(13)),
      pngChunk('eXIf', Buffer.from('gps-here', 'latin1')),
      pngChunk('tEXt', Buffer.from('Comment\0secret', 'latin1')),
      pngChunk('acTL', Buffer.alloc(8)), // APNG animation control — must survive
      pngChunk('IDAT', Buffer.from('pixels', 'latin1')),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);

    const out = scrubMetadata(input, 'png');
    expect(listPngChunks(out)).toEqual(['IHDR', 'acTL', 'IDAT', 'IEND']);
    expect(out.toString('latin1')).not.toContain('gps-here');
    expect(out.toString('latin1')).not.toContain('secret');
  });

  it('returns the input unchanged when there is no metadata', () => {
    const input = Buffer.concat([
      PNG_SIG,
      pngChunk('IHDR', Buffer.alloc(13)),
      pngChunk('IDAT', Buffer.from('pixels', 'latin1')),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(scrubMetadata(input, 'png')).toBe(input);
  });
});

// ---- GIF -------------------------------------------------------------------

describe('scrubMetadata — GIF', () => {
  it('is a no-op on a comment-free animated GIF', () => {
    expect(scrubMetadata(TWO_FRAME_GIF, 'gif')).toBe(TWO_FRAME_GIF);
  });

  it('removes a Comment Extension and restores the original bytes', () => {
    const comment = Buffer.concat([
      Buffer.from([0x21, 0xfe, 0x0a]),
      Buffer.from('SECRET-GPS', 'latin1'),
      Buffer.from([0x00]),
    ]);
    const withComment = insertBeforeTrailer(TWO_FRAME_GIF, comment);

    const out = scrubMetadata(withComment, 'gif');
    expect(out.toString('latin1')).not.toContain('SECRET-GPS');
    // The NETSCAPE looping extension is preserved.
    expect(out.toString('latin1')).toContain('NETSCAPE2.0');
    // Removing exactly what we added reproduces the original.
    expect(Buffer.compare(out, TWO_FRAME_GIF)).toBe(0);
  });

  it('removes an XMP Application Extension but keeps NETSCAPE', () => {
    const xmp = Buffer.concat([
      Buffer.from([0x21, 0xff, 0x0b]),
      Buffer.from('XMP DataXMP', 'latin1'),
      Buffer.from([0x03]),
      Buffer.from('abc', 'latin1'),
      Buffer.from([0x00]),
    ]);
    const withXmp = insertBeforeTrailer(TWO_FRAME_GIF, xmp);

    const out = scrubMetadata(withXmp, 'gif');
    expect(out.toString('latin1')).not.toContain('XMP DataXMP');
    expect(out.toString('latin1')).toContain('NETSCAPE2.0');
    expect(Buffer.compare(out, TWO_FRAME_GIF)).toBe(0);
  });

  it('bails on a non-GIF buffer handed in as gif', () => {
    const garbage = Buffer.from('definitely not a gif at all here', 'latin1');
    expect(scrubMetadata(garbage, 'gif')).toBe(garbage);
  });
});

// ---- SVG -------------------------------------------------------------------

describe('scrubMetadata — SVG', () => {
  it('strips <metadata> elements and XML comments', () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<!-- author: Jane, taken at 40.7,-74.0 -->' +
        '<metadata id="m"><rdf:RDF>secret</rdf:RDF></metadata>' +
        '<rect width="10" height="10"/></svg>',
      'utf8',
    );
    const out = scrubMetadata(svg, 'svg').toString('utf8');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('author: Jane');
    expect(out).toContain('<rect width="10" height="10"/>');
  });

  it('returns the input unchanged when there is nothing to strip', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8');
    expect(scrubMetadata(svg, 'svg')).toBe(svg);
  });
});

// ---- dispatch --------------------------------------------------------------

describe('scrubMetadata — dispatch', () => {
  it('returns the input unchanged for formats without a scrubber', () => {
    const jpeg = Buffer.from('jpeg-ish bytes', 'latin1');
    expect(scrubMetadata(jpeg, 'jpeg')).toBe(jpeg);
    expect(scrubMetadata(jpeg, undefined)).toBe(jpeg);
  });
});

describe('canScrubInPlace', () => {
  it('is true only for the surgically-scrubbable containers', () => {
    for (const f of ['webp', 'png', 'gif', 'svg']) expect(canScrubInPlace(f)).toBe(true);
    // Formats that can be animated/multi-page but have no in-place scrubber must
    // report false so optimize() routes them through the re-encode fallback
    // rather than passing their EXIF through untouched.
    for (const f of ['tiff', 'avif', 'heif', 'jpeg', undefined])
      expect(canScrubInPlace(f)).toBe(false);
  });
});
