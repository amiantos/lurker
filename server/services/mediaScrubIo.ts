// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What the media scrubbers share: the error they refuse with, and a file handle
// wrapped for the access pattern every one of them has — thousands of tiny header
// reads walking forward through a file, and a few small writes.
//
// See services/mediaScrub.ts for what a scrubber is and is not.

import type fs from 'node:fs';

/** A container we could not make sense of. The route turns this into a 415.
 *  Deliberately NOT a passthrough fallback (which is what the image scrubbers do):
 *  there is no sharp re-encode behind us to catch what we miss, and the failure mode
 *  is someone's home address in a public channel. Refusing the upload is the
 *  conservative answer. */
export class MediaScrubError extends Error {
  code = 'MEDIA_SCRUB_FAILED';
}

const ZERO_CHUNK = Buffer.alloc(64 * 1024);

/** Overwrite a byte range with zeros, chunked so a huge box can't blow up memory. */
export async function zeroRange(
  fh: fs.promises.FileHandle,
  start: number,
  end: number,
): Promise<void> {
  let pos = start;
  while (pos < end) {
    const n = Math.min(ZERO_CHUNK.length, end - pos);
    await fh.write(ZERO_CHUNK, 0, n, pos);
    pos += n;
  }
}

// A WebM straight out of a browser recorder has a cluster of unknown size, so the
// only way to its end is to step over every block in it; an Ogg file is nothing but
// pages. Either is a header read every few kilobytes for the length of the file, and
// one syscall per header is seconds on a large upload. One window per 64 KiB is not.
const WINDOW_BYTES = 64 * 1024;

/**
 * An open upload, for a scrubber that walks it.
 *
 * `peek` serves reads from a sliding window. Every write goes through here too, so
 * the window can never hand back bytes a scrub has since replaced.
 */
export class ScrubFile {
  readonly size: number;
  private readonly fh: fs.promises.FileHandle;
  private readonly window = Buffer.alloc(WINDOW_BYTES);
  private windowStart = 0;
  private windowLength = 0;

  constructor(fh: fs.promises.FileHandle, size: number) {
    this.fh = fh;
    this.size = size;
  }

  /**
   * Up to `length` bytes at `pos` — fewer only where the file ends first.
   *
   * ⚠ The result is a view into the window and is overwritten by the next `peek`.
   * Read what you need out of it before awaiting anything else on this file.
   */
  async peek(pos: number, length: number): Promise<Buffer> {
    if (length > WINDOW_BYTES) throw new MediaScrubError('header too large');
    const end = Math.min(pos + length, this.size);
    if (end <= pos) return this.window.subarray(0, 0);
    if (pos < this.windowStart || end > this.windowStart + this.windowLength) {
      const { bytesRead } = await this.fh.read(this.window, 0, WINDOW_BYTES, pos);
      this.windowStart = pos;
      this.windowLength = bytesRead;
    }
    const from = pos - this.windowStart;
    return this.window.subarray(from, Math.min(from + (end - pos), this.windowLength));
  }

  /** Exactly `length` bytes at `pos`, as a buffer the caller owns. For the few
   *  things a scrubber has to hold whole: a comment header, a codec's private data. */
  async read(pos: number, length: number): Promise<Buffer> {
    const out = Buffer.alloc(length);
    const { bytesRead } = await this.fh.read(out, 0, length, pos);
    if (bytesRead < length) throw new MediaScrubError('file ends inside a header');
    return out;
  }

  async write(bytes: Buffer, pos: number): Promise<void> {
    this.windowLength = 0;
    await this.fh.write(bytes, 0, bytes.length, pos);
  }

  async zero(start: number, end: number): Promise<void> {
    this.windowLength = 0;
    await zeroRange(this.fh, start, end);
  }
}

/**
 * Empty a Vorbis-style comment header in place: no vendor string, no comments.
 *
 * Ogg Vorbis, Opus, Theora and Speex all carry their tags in the same structure
 * (vendor length, vendor, count, comments) behind a different magic, and so does a
 * Vorbis or Theora track's codec data in Matroska. It is where the artist and title
 * live, and also a base64 cover image, which can hold EXIF of its own.
 *
 * The packet keeps its length — the two zeroed length fields declare an empty
 * header and the rest becomes padding, which every decoder steps over (and which
 * RFC 7845 §5.2 spells out for Opus). `framing` is the Vorbis framing bit, the one
 * byte that must follow the comments there.
 */
export function blankCommentHeader(packet: Buffer, magic: Buffer, framing: boolean): void {
  const lengths = 8; // vendor_length + user_comment_list_length
  if (packet.length < magic.length + lengths + (framing ? 1 : 0)) {
    throw new MediaScrubError('comment header too short');
  }
  if (!packet.subarray(0, magic.length).equals(magic)) {
    throw new MediaScrubError('comment header not where the codec puts it');
  }
  packet.fill(0, magic.length);
  if (framing) packet[magic.length + lengths] = 1;
}
