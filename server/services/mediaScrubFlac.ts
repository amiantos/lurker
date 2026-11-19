// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The FLAC part of services/mediaScrub.ts (#553).
//
// A FLAC stream is the marker `fLaC`, a run of metadata blocks, then audio frames.
// Each block is a one-byte type (top bit: "this is the last one"), a 24-bit length
// and a payload. Type 1 is PADDING, which exists so a tagger can grow a tag without
// rewriting the file — a block is neutralized by retyping it to PADDING and zeroing
// it. Nothing moves, so the seek table's offsets into the audio stay right.

import { MediaScrubError, type ScrubFile } from './mediaScrubIo.js';

const STREAMINFO = 0;
const PADDING = 1;
const SEEKTABLE = 3;

// The blocks a decoder needs. Everything else goes: VORBIS_COMMENT (the tags),
// PICTURE (cover art, which can carry EXIF of its own), CUESHEET (a disc's catalog
// number and ISRCs), APPLICATION (anything at all), and any type added later.
// PADDING is not on the list either: it keeps its type and is zeroed like the rest,
// because nothing makes a tagger that shrank a tag clear what it left behind.
const KEPT = new Set([STREAMINFO, SEEKTABLE]);

/**
 * Neutralize the metadata blocks of the FLAC stream that starts at `start`.
 *
 * Takes a range rather than a file because a FLAC track inside Matroska keeps this
 * same structure as its codec data (see mediaScrubEbml.ts), and it can carry the
 * same tags and the same cover image there.
 */
export async function scrubFlacBlocks(file: ScrubFile, start: number, end: number): Promise<void> {
  const marker = await file.peek(start, 4);
  if (marker.toString('latin1') !== 'fLaC') throw new MediaScrubError('not a FLAC stream');

  let pos = start + 4;
  for (;;) {
    const header = await file.peek(pos, 4);
    if (header.length < 4) throw new MediaScrubError('truncated FLAC metadata');
    const last = (header[0] & 0x80) !== 0;
    const type = header[0] & 0x7f;
    const blockEnd = pos + 4 + header.readUIntBE(1, 3);
    if (type === 0x7f || blockEnd > end) {
      throw new MediaScrubError(`malformed FLAC metadata block at offset ${pos}`);
    }

    if (!KEPT.has(type)) {
      if (type !== PADDING) await file.write(Buffer.from([(last ? 0x80 : 0) | PADDING]), pos);
      await file.zero(pos + 4, blockEnd);
    }

    if (last) return;
    pos = blockEnd;
  }
}
