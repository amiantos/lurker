// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Strip metadata from audio/video, IN PLACE, without decoding a frame.
//
// This is NOT a media pipeline and must never become one. We do not transcode
// (decision 22): video is never rendered inline, so there's no shrink-for-chat
// imperative, and a minutes-long CPU peg would starve the event loop on a shared
// box. This is a header edit — we walk the container's box tree, skip straight over
// the payload (`mdat`) by its declared length, and zero the handful of ranges that
// hold metadata.
//
// WHY IT EXISTS: a video straight off a phone carries GPS in `moov/udta` — the same
// leak #516 closed for photos, in the format people are most likely to share from a
// camera roll. Passing video through untouched would quietly re-open it. And the
// scrub has to be OURS: chibisafe has an optional strip-EXIF flag and Zipline v4
// removes GPS itself, but by the time a driver strips anything the bytes have
// already left this machine with the coordinates in them (decision 23).
//
// EVERY EDIT IS SIZE-PRESERVING, which is what makes this safe:
//   • Boxes are neutralized by RETYPING them to `free` — the ISO spec's own "ignore
//     this padding" box — and zeroing the payload. The byte length never changes,
//     so no chunk offsets shift (`stco`/`co64` point into `mdat`) and there is no
//     way to corrupt the file by getting the arithmetic wrong.
//   • ID3v2's frame area is zeroed but its declared size is kept: trailing zeros are
//     legal ID3v2 padding. ID3v1's `TAG` magic is kept and its fields blanked.
// So the scrub is a few pwrite() calls against the upload's temp file, costs no
// memory, and leaves req.file.size still correct.
//
// Companion to services/metadataScrub.ts, which does the same job for image
// containers (WebP/PNG/GIF/SVG) but on a Buffer — images are small and bounded, so
// they can afford it. Media can't.

import fs from 'node:fs';

/** A container we could not make sense of. The route turns this into a 415.
 *  Deliberately NOT a passthrough fallback (which is what the image scrubbers do):
 *  there is no sharp re-encode behind us to catch what we miss, and the failure mode
 *  is someone's home address in a public channel. Refusing the upload is the
 *  conservative answer. */
export class MediaScrubError extends Error {
  code = 'MEDIA_SCRUB_FAILED';
}

// Boxes whose entire contents are metadata. `udta` (user data — this is where
// ©xyz GPS, ©mak/©mod device info and com.apple.quicktime.* live), `meta`
// (iTunes-style ilst metadata), and `uuid` (where XMP hides).
const NEUTRALIZE = new Set(['udta', 'meta', 'uuid']);

// Boxes we descend into looking for the above. `udta` hangs off `moov` and off each
// `trak`; `meta` off `moov` (and, in some writers, the top level).
const CONTAINERS = new Set(['moov', 'trak', 'mdia']);

// Header boxes carrying creation/modification timestamps — "when was this recorded"
// is metadata too, and a phone writes it. Fixed-size fields, so zeroing them can't
// shift anything; 0 is the spec's "unset".
const TIMESTAMPED = new Set(['mvhd', 'tkhd', 'mdhd']);

// Real files bottom out at moov → trak → mdia (depth 3). The headroom is generous;
// exceeding it means the tree isn't one a muxer produced.
const MAX_BOX_DEPTH = 8;

const FREE = Buffer.from('free');
const ZERO_CHUNK = Buffer.alloc(64 * 1024);

/** Overwrite a byte range with zeros, chunked so a huge box can't blow up memory. */
async function zeroRange(fh: fs.promises.FileHandle, start: number, end: number): Promise<void> {
  let pos = start;
  while (pos < end) {
    const n = Math.min(ZERO_CHUNK.length, end - pos);
    await fh.write(ZERO_CHUNK, 0, n, pos);
    pos += n;
  }
}

/**
 * Walk an ISO-BMFF box tree between [start, end), neutralizing metadata boxes.
 * Recursion is bounded by the box sizes themselves; `mdat` is never read, only
 * stepped over.
 */
async function walkBoxes(
  fh: fs.promises.FileHandle,
  start: number,
  end: number,
  depth: number,
): Promise<void> {
  // A real file bottoms out at depth 3 (moov → trak → mdia), so this is unreachable
  // for anything a muxer wrote. REFUSE rather than return: giving up quietly would
  // leave a `udta` below the guard un-scrubbed, which is neither scrubbing nor
  // refusing — the exact middle ground this module promises not to occupy. (Nesting
  // `moov` inside `moov` to hide metadata only hides the uploader's OWN metadata
  // from us, so this is a contract fix, not an exploit fix.)
  if (depth > MAX_BOX_DEPTH) {
    throw new MediaScrubError(`box nesting deeper than ${MAX_BOX_DEPTH} — refusing to guess`);
  }
  let pos = start;
  const header = Buffer.alloc(16);

  while (pos + 8 <= end) {
    const { bytesRead } = await fh.read(header, 0, 16, pos);
    if (bytesRead < 8) return;

    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;

    if (size === 1) {
      // 64-bit largesize follows the type.
      if (bytesRead < 16) throw new MediaScrubError('truncated 64-bit box header');
      const large = header.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new MediaScrubError('box too large');
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      // "extends to end of file"
      size = end - pos;
    }

    if (size < headerSize || pos + size > end) {
      throw new MediaScrubError(`malformed box "${type}" at offset ${pos}`);
    }

    if (NEUTRALIZE.has(type)) {
      // Retype to `free` and wipe the payload. Length is untouched, so every offset
      // elsewhere in the file stays valid.
      await fh.write(FREE, 0, 4, pos + 4);
      await zeroRange(fh, pos + headerSize, pos + size);
    } else if (TIMESTAMPED.has(type)) {
      await zeroTimestamps(fh, pos + headerSize, pos + size, type);
    } else if (CONTAINERS.has(type)) {
      await walkBoxes(fh, pos + headerSize, pos + size, depth + 1);
    }
    // Anything else (ftyp, mdat, free, moof, …) is stepped over untouched.

    pos += size;
  }
}

/** Zero creation_time + modification_time in an mvhd/tkhd/mdhd. Both are 4 bytes in
 *  a version-0 box and 8 bytes in a version-1 box, and both sit immediately after
 *  the version/flags word in all three box types. */
async function zeroTimestamps(
  fh: fs.promises.FileHandle,
  payloadStart: number,
  payloadEnd: number,
  type: string,
): Promise<void> {
  const vf = Buffer.alloc(1);
  const { bytesRead } = await fh.read(vf, 0, 1, payloadStart);
  if (bytesRead < 1) throw new MediaScrubError(`truncated ${type}`);
  const version = vf[0];
  const width = version === 1 ? 8 : 4;
  const from = payloadStart + 4; // skip version(1) + flags(3)
  const to = from + width * 2; // creation_time + modification_time
  if (to > payloadEnd) throw new MediaScrubError(`truncated ${type} timestamps`);
  await zeroRange(fh, from, to);
}

/** ID3 tags on an MP3. Both edits keep the file length identical. */
async function scrubId3(fh: fs.promises.FileHandle, size: number): Promise<void> {
  // ID3v2 prefix: "ID3" ver(2) flags(1) size(4, synchsafe — 7 bits per byte).
  const head = Buffer.alloc(10);
  const { bytesRead } = await fh.read(head, 0, 10, 0);
  if (bytesRead === 10 && head.toString('latin1', 0, 3) === 'ID3') {
    const tagSize =
      ((head[6] & 0x7f) << 21) |
      ((head[7] & 0x7f) << 14) |
      ((head[8] & 0x7f) << 7) |
      (head[9] & 0x7f);
    const end = Math.min(10 + tagSize, size);
    // Keep the header and its declared size; blank the frames. Zeros inside an
    // ID3v2 tag are padding, which the spec allows, so the tag stays well-formed
    // and every byte offset after it is unchanged.
    if (end > 10) await zeroRange(fh, 10, end);
  }

  // ID3v1 trailer: the last 128 bytes, starting "TAG". Keep the magic (so it stays a
  // valid, empty tag rather than 128 bytes of garbage a decoder might try to play)
  // and blank the fields.
  if (size >= 128) {
    const tail = Buffer.alloc(3);
    await fh.read(tail, 0, 3, size - 128);
    if (tail.toString('latin1') === 'TAG') {
      await zeroRange(fh, size - 128 + 3, size);
    }
  }
}

/**
 * Strip metadata from a media file in place. The file's length is unchanged, so a
 * caller's recorded size stays correct.
 *
 * Throws MediaScrubError if the container doesn't parse — see the class comment for
 * why that's a refusal rather than a passthrough.
 */
export async function scrubMediaFile(path: string, mime: string): Promise<void> {
  const fh = await fs.promises.open(path, 'r+');
  try {
    const { size } = await fh.stat();
    if (mime === 'audio/mpeg') {
      await scrubId3(fh, size);
      return;
    }
    // Everything else we accept is ISO-BMFF: mp4, mov, m4v, m4a.
    await walkBoxes(fh, 0, size, 0);
  } catch (err) {
    if (err instanceof MediaScrubError) throw err;
    throw new MediaScrubError(`could not process this media file: ${(err as Error).message}`);
  } finally {
    await fh.close();
  }
}
