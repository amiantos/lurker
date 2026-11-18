// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The Ogg part of services/mediaScrub.ts (#553): Vorbis, Opus, Theora and Speex.
//
// An Ogg file is a sequence of pages. Each belongs to one logical stream (its
// serial number) and carries segments of that stream's packets; a packet runs on
// through segments, and across pages, until a segment shorter than 255 bytes. All
// four codecs put their tags in the stream's SECOND packet — see
// blankCommentHeader for what is in it.
//
// That packet is emptied without changing its length, so no page moves. What does
// change is each touched page's checksum, which is recomputed; a decoder drops a
// page whose checksum is wrong.

import { MediaScrubError, ScrubFile, blankCommentHeader } from './mediaScrubIo.js';

interface Codec {
  /** How the stream's first packet opens. */
  id: string;
  /** How its comment packet opens. */
  magic: string;
  /** Vorbis ends its comments with a framing bit; the others do not. */
  framing: boolean;
}

// ⚠ A stream that is none of these is REFUSED, not skipped. FLAC-in-Ogg spreads its
// metadata over several packets, a Skeleton track describes the other streams in
// free-form headers, and an OGM stream is none of our business; passing any of them
// through because the walker did not know where to look is the outcome this module
// exists to prevent.
const CODECS: Codec[] = [
  { id: '\x01vorbis', magic: '\x03vorbis', framing: true },
  { id: 'OpusHead', magic: 'OpusTags', framing: false },
  { id: '\x80theora', magic: '\x81theora', framing: false },
  { id: 'Speex   ', magic: '', framing: false },
];

// A comment packet is read whole. They are small unless they hold a cover image.
const MAX_COMMENT_BYTES = 32 * 1024 * 1024;

const PAGE_HEADER = 27;
const BEGINNING_OF_STREAM = 0x02;

interface Span {
  start: number;
  end: number;
}

interface Stream {
  codec: Codec | null;
  /** Packets finished so far. The scrub is done with a stream at 2. */
  packets: number;
  /** Where the packet being assembled lies, and which pages hold it. */
  body: Span[];
  pages: Span[];
}

// Ogg's CRC-32: polynomial 0x04C11DB7, not reflected, initial value and final XOR
// both zero. Not zlib's, so node:zlib's crc32 is no use here.
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let bit = 0; bit < 8; bit++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  CRC_TABLE[i] = r >>> 0;
}

export function oggCrc(page: Buffer): number {
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ CRC_TABLE[(crc >>> 24) ^ byte]) >>> 0;
  return crc;
}

/** Add a run of packet bytes, joined to the previous run when they touch. */
function pushBody(spans: Span[], start: number, end: number): void {
  const last = spans[spans.length - 1];
  if (last && last.end === start) last.end = end;
  else spans.push({ start, end });
}

/** Note a page as holding part of the packet. Never joined: each is checksummed
 *  on its own. */
function pushPage(spans: Span[], start: number, end: number): void {
  if (spans[spans.length - 1]?.start !== start) spans.push({ start, end });
}

async function finishPacket(file: ScrubFile, stream: Stream): Promise<void> {
  const length = stream.body.reduce((n, s) => n + (s.end - s.start), 0);

  if (stream.packets === 0) {
    const head = stream.body.length
      ? (await file.peek(stream.body[0].start, Math.min(8, length))).toString('latin1')
      : '';
    const codec = CODECS.find((c) => head.startsWith(c.id));
    if (!codec) throw new MediaScrubError('an Ogg stream in a codec Lurker cannot clean');
    stream.codec = codec;
    return;
  }

  if (length > MAX_COMMENT_BYTES) throw new MediaScrubError('comment header too large');
  const packet = Buffer.concat(
    await Promise.all(stream.body.map((s) => file.read(s.start, s.end - s.start))),
  );
  const { magic, framing } = stream.codec!;
  blankCommentHeader(packet, Buffer.from(magic, 'latin1'), framing);

  let at = 0;
  for (const span of stream.body) {
    const n = span.end - span.start;
    await file.write(packet.subarray(at, at + n), span.start);
    at += n;
  }
  for (const span of stream.pages) {
    const page = await file.read(span.start, span.end - span.start);
    page.writeUInt32LE(0, 22); // the checksum is computed with its own field zeroed
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(oggCrc(page));
    await file.write(crc, span.start + 22);
  }
}

/**
 * Strip the tags from every stream in an Ogg file.
 *
 * Walks every page, not just the first few: a chained file (one recording appended
 * to another, which is what a captured radio stream is) starts new streams, each
 * with comments of its own, anywhere.
 */
export async function scrubOgg(file: ScrubFile): Promise<void> {
  const streams = new Map<number, Stream>();
  let pos = 0;

  while (pos < file.size) {
    const header = await file.peek(pos, PAGE_HEADER);
    // A file cut off inside its last page. Whether that matters is decided below,
    // by whether every stream got as far as its comments.
    if (header.length < PAGE_HEADER) break;
    if (header.toString('latin1', 0, 4) !== 'OggS' || header[4] !== 0) {
      throw new MediaScrubError(`not an Ogg page at offset ${pos}`);
    }
    const flags = header[5];
    const serial = header.readUInt32LE(14);
    const segmentCount = header[26];

    const table = await file.peek(pos + PAGE_HEADER, segmentCount);
    if (table.length < segmentCount) break;
    const lacing = Buffer.from(table); // peek's view does not outlive the next peek
    const bodyStart = pos + PAGE_HEADER + segmentCount;
    const pageEnd = bodyStart + lacing.reduce((n, v) => n + v, 0);
    if (pageEnd > file.size) break;

    if (flags & BEGINNING_OF_STREAM) {
      streams.set(serial, { codec: null, packets: 0, body: [], pages: [] });
    }
    const stream = streams.get(serial);
    if (!stream) throw new MediaScrubError('an Ogg page from a stream that never began');

    let at = bodyStart;
    for (const value of lacing) {
      if (stream.packets >= 2) break;
      if (value > 0) pushBody(stream.body, at, at + value);
      pushPage(stream.pages, pos, pageEnd);
      at += value;
      if (value < 255) {
        await finishPacket(file, stream);
        stream.packets++;
        stream.body = [];
        stream.pages = [];
      }
    }

    pos = pageEnd;
  }

  if (streams.size === 0) throw new MediaScrubError('not an Ogg file');
  for (const stream of streams.values()) {
    if (stream.packets < 2) throw new MediaScrubError('an Ogg stream with no comment header');
  }
}
