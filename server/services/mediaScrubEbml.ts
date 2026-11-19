// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The Matroska / WebM half of services/mediaScrub.ts (#553). Same contract: an
// in-place header edit, no frame decoded, file length unchanged.
//
// WHAT IS IN ONE. A browser recording carries little — a muxer name. But the same
// container comes out of OBS, ffmpeg and mkvmerge, and those write `Tags` (free-form
// key/value: title, artist, location, whatever the source file had), a `Title`, a
// recording date, track names, attached files and chapter names.
//
// HOW IT STAYS SIZE-PRESERVING. EBML has `Void`, an element a reader skips — the
// role `free` plays in MP4. An element is replaced by a Void of the same TOTAL
// length, so `SeekHead` and `Cues`, which hold absolute byte offsets, stay right.
// The ids differ in length (`Tags` is four bytes, `Void` one), which is no obstacle:
// a size may be written wider than it needs to be, so the Void's size field takes up
// the slack.
//
// CRC-32. A master element may open with a checksum of everything after it. Editing
// under one would leave it wrong and a strict reader would discard the element, so
// the checksum of every master edited here is voided too — it is optional.
//
// A VOID THAT WAS ALREADY THERE is emptied as well. A reader skips its contents, so
// nothing says they are zeros: a tool that removed a Tags element by retyping it,
// as this one does, may have left the tags inside.

import { MediaScrubError, ScrubFile, blankCommentHeader } from './mediaScrubIo.js';
import { scrubFlacBlocks } from './mediaScrubFlac.js';

const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NAME = 0x536e;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const CLUSTER = 0x1f43b675;
const CUES = 0x1c53bb6b;
const TAGS = 0x1254c367;
const ATTACHMENTS = 0x1941a469;
const CHAPTERS = 0x1043a770;
const VOID = 0xec;
const CRC32 = 0xbf;

// Top-level elements that are metadata from end to end.
const NEUTRALIZE = new Set([TAGS, ATTACHMENTS, CHAPTERS]);

// What can follow a cluster. A cluster of unknown size (every live recording has
// them) has no length to step over; it ends where one of these begins.
const AFTER_CLUSTER = new Set([
  EBML_HEADER,
  SEGMENT,
  SEEK_HEAD,
  INFO,
  TRACKS,
  CLUSTER,
  CUES,
  TAGS,
  ATTACHMENTS,
  CHAPTERS,
]);

// `Info` children that identify the file or who made it: SegmentUUID,
// SegmentFilename, PrevUUID, PrevFilename, NextUUID, NextFilename, SegmentFamily,
// Title and DateUTC. TimestampScale and Duration are what a player needs, and stay.
const INFO_VOIDED = new Set([
  0x73a4, 0x7384, 0x3cb923, 0x3c83ab, 0x3eb923, 0x3e83bb, 0x4444, 0x7ba9, 0x4461,
]);

// MuxingApp and WritingApp are mandatory, so they are emptied rather than voided:
// a string may be padded with zeros, and one that is all padding is an empty string.
const INFO_BLANKED = new Set([0x4d80, 0x5741]);

// Codec data is read whole. A Vorbis setup header is a few kilobytes; a FLAC track's
// can hold a cover image, hence the headroom.
const MAX_CODEC_PRIVATE = 32 * 1024 * 1024;

interface Element {
  id: number;
  /** Offset of the element's own header. */
  start: number;
  /** Offset of the payload. */
  data: number;
  /** Offset just past the element, or null when its size is unknown. */
  end: number | null;
}

/** Parse the element header at `pos`. Null where the file ends before the header
 *  does, which a caller inside a sized element treats as corruption. */
async function elementAt(file: ScrubFile, pos: number): Promise<Element | null> {
  const head = await file.peek(pos, 12); // id ≤ 4 bytes, size ≤ 8
  if (head.length < 2) return null;

  const idLength = Math.clz32(head[0]) - 23; // leading zeros of the byte, plus one
  if (idLength > 4) throw new MediaScrubError(`invalid element id at offset ${pos}`);
  if (head.length < idLength + 1) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + head[i];

  const first = head[idLength];
  const sizeLength = Math.clz32(first) - 23;
  if (sizeLength > 8) throw new MediaScrubError(`invalid element size at offset ${pos}`);
  if (head.length < idLength + sizeLength) return null;

  // All ones is "unknown size". Otherwise a plain big-endian number once the length
  // marker is masked off; anything past 2^53 is past the end of the file anyway.
  let size = first & (0xff >> sizeLength);
  let unknown = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const byte = head[idLength + i];
    if (byte !== 0xff) unknown = false;
    size = size * 256 + byte;
  }

  const data = pos + idLength + sizeLength;
  return { id, start: pos, data, end: unknown ? null : data + size };
}

/** Replace [start, end) with one Void element of exactly that length. */
async function voidRange(file: ScrubFile, start: number, end: number): Promise<void> {
  const total = end - start;
  if (total < 2) throw new MediaScrubError('element too small to void');
  let header: Buffer;
  if (total < 9) {
    header = Buffer.from([VOID, 0x80 | (total - 2)]);
  } else {
    // An eight-byte size: 0x01, then 56 bits. Wider than the value needs, which is
    // what lets one Void stand in for an element whose own header was any length.
    header = Buffer.alloc(9);
    header[0] = VOID;
    header.writeBigUInt64BE((1n << 56n) | BigInt(total - 9), 1);
  }
  await file.write(header, start);
  await file.zero(start + header.length, end);
}

/** Zero the contents of a Void the file came with. */
async function emptyVoid(file: ScrubFile, el: Element): Promise<void> {
  if (el.end !== null && el.end > el.data) await file.zero(el.data, Math.min(el.end, file.size));
}

/** The children of a sized master element, in order. A child that does not fit is
 *  a refusal: something under here did not parse, and what we could not read we
 *  could not clean. */
async function* children(file: ScrubFile, start: number, end: number): AsyncGenerator<Element> {
  let pos = start;
  while (pos < end) {
    const el = await elementAt(file, pos);
    if (!el || el.end === null || el.end > end) {
      throw new MediaScrubError(`malformed element at offset ${pos}`);
    }
    yield el;
    pos = el.end;
  }
}

async function scrubInfo(file: ScrubFile, start: number, end: number): Promise<void> {
  for await (const el of children(file, start, end)) {
    if (el.id === CRC32 || INFO_VOIDED.has(el.id)) {
      await voidRange(file, el.start, el.end!);
    } else if (INFO_BLANKED.has(el.id)) {
      await file.zero(el.data, el.end!);
    } else if (el.id === VOID) {
      await emptyVoid(file, el);
    }
  }
}

async function scrubSeekHead(file: ScrubFile, start: number, end: number): Promise<void> {
  for await (const el of children(file, start, end)) {
    if (el.id === CRC32) {
      await voidRange(file, el.start, el.end!);
    } else if (el.id === VOID) {
      await emptyVoid(file, el);
    } else if (el.id === SEEK && el.end! - el.data <= 64) {
      // An index entry for something that is about to stop existing. A reader that
      // followed it would only find a Void, but an index should not point at one.
      const entry = await file.read(el.data, el.end! - el.data);
      const target = Buffer.alloc(4);
      for (const id of NEUTRALIZE) {
        target.writeUInt32BE(id);
        if (entry.includes(target)) {
          await voidRange(file, el.start, el.end!);
          break;
        }
      }
    }
  }
}

async function scrubTracks(file: ScrubFile, start: number, end: number): Promise<void> {
  for await (const el of children(file, start, end)) {
    if (el.id === CRC32) await voidRange(file, el.start, el.end!);
    else if (el.id === VOID) await emptyVoid(file, el);
    else if (el.id === TRACK_ENTRY) await scrubTrackEntry(file, el.data, el.end!);
  }
}

async function scrubTrackEntry(file: ScrubFile, start: number, end: number): Promise<void> {
  let codec = '';
  let codecPrivate: Element | null = null;
  for await (const el of children(file, start, end)) {
    if (el.id === CRC32 || el.id === TRACK_NAME) {
      // A track name is whatever the recorder called the source: "Alex's Yeti".
      await voidRange(file, el.start, el.end!);
    } else if (el.id === VOID) {
      await emptyVoid(file, el);
    } else if (el.id === CODEC_ID && el.end! - el.data <= 64) {
      codec = (await file.read(el.data, el.end! - el.data)).toString('latin1');
    } else if (el.id === CODEC_PRIVATE) {
      codecPrivate = el;
    }
  }
  if (!codecPrivate) return;

  // Three codecs keep their headers here as they would sit in their own container,
  // and those headers include the tags. Everything else's codec data is decoder
  // configuration.
  codec = codec.replace(/\0+$/, '');
  if (codec === 'A_VORBIS') {
    await scrubXiphHeaders(file, codecPrivate, Buffer.from('\x03vorbis', 'latin1'), true);
  } else if (codec === 'V_THEORA') {
    await scrubXiphHeaders(file, codecPrivate, Buffer.from('\x81theora', 'latin1'), false);
  } else if (codec === 'A_FLAC') {
    await scrubFlacBlocks(file, codecPrivate.data, codecPrivate.end!);
  }
}

/** Vorbis and Theora codec data: a count, the sizes of all packets but the last,
 *  then the packets — identification, comments, setup. */
async function scrubXiphHeaders(
  file: ScrubFile,
  el: Element,
  magic: Buffer,
  framing: boolean,
): Promise<void> {
  const length = el.end! - el.data;
  if (length > MAX_CODEC_PRIVATE) throw new MediaScrubError('codec headers too large');
  const data = await file.read(el.data, length);
  if (data[0] !== 2) throw new MediaScrubError('expected three codec headers');

  let pos = 1;
  const sizes: number[] = [];
  for (let i = 0; i < 2; i++) {
    let size = 0;
    for (;;) {
      if (pos >= data.length) throw new MediaScrubError('truncated codec headers');
      const byte = data[pos++];
      size += byte;
      if (byte !== 0xff) break;
    }
    sizes.push(size);
  }
  const from = pos + sizes[0];
  const to = from + sizes[1];
  if (to > data.length) throw new MediaScrubError('truncated codec headers');

  const comments = data.subarray(from, to);
  blankCommentHeader(comments, magic, framing);
  await file.write(comments, el.data + from);
}

/**
 * Strip metadata from a Matroska or WebM file.
 *
 * One flat walk. A Segment is stepped INTO rather than over, so its children are
 * visited by the same loop that found it; that is also what makes a Segment of
 * unknown size, and a second one after it, need no special case.
 */
export async function scrubEbml(file: ScrubFile): Promise<void> {
  const first = await elementAt(file, 0);
  if (!first || first.id !== EBML_HEADER) throw new MediaScrubError('not an EBML file');

  let pos = 0;
  while (pos < file.size) {
    const el = await elementAt(file, pos);
    // A few bytes after the last element: too short to be one, so too short to
    // hold anything.
    if (!el) break;

    if (el.id === SEGMENT) {
      pos = el.data;
      continue;
    }
    if (el.id === CLUSTER) {
      // A recording that was cut off ends in a cluster longer than the file. There
      // is nothing after it to clean.
      pos = el.end ?? (await endOfUnsizedCluster(file, el.data));
      continue;
    }
    if (el.end === null || el.end > file.size) {
      throw new MediaScrubError(`malformed element at offset ${pos}`);
    }

    if (el.id === CRC32 || NEUTRALIZE.has(el.id)) await voidRange(file, pos, el.end);
    else if (el.id === INFO) await scrubInfo(file, el.data, el.end);
    else if (el.id === TRACKS) await scrubTracks(file, el.data, el.end);
    else if (el.id === SEEK_HEAD) await scrubSeekHead(file, el.data, el.end);
    else if (el.id === VOID) await emptyVoid(file, el);
    // Anything else (the EBML header, Cues, an element newer than this code) is
    // stepped over untouched.

    pos = el.end;
  }
}

/** Step over the blocks of a cluster that did not say how long it is, to the next
 *  element that cannot be inside one. */
async function endOfUnsizedCluster(file: ScrubFile, start: number): Promise<number> {
  let pos = start;
  while (pos < file.size) {
    const el = await elementAt(file, pos);
    if (!el) return file.size;
    if (AFTER_CLUSTER.has(el.id)) return pos;
    if (el.end === null) throw new MediaScrubError(`unsized element at offset ${pos}`);
    if (el.id === VOID) await emptyVoid(file, el);
    pos = el.end;
  }
  return file.size;
}
