// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What IS this file? Decided from its magic bytes, on the server, every time.
//
// THE RULE: the bytes have absolute authority over the class. The client's claimed
// MIME is consulted for exactly one thing — telling text apart from SVG among
// signature-less UTF-8 content — where it cannot cause a bypass, because a real
// image would have been caught by the sniff regardless of what it was called.
//
// Why it has to be this way: the route used to take the client's word for it
// (`req.file.mimetype === 'text/plain'`). That was survivable while the only two
// outcomes were "image pipeline" or "text passthrough" — nobody gains by lying. The
// moment a class means "your bytes go out untouched", a claimed MIME becomes a
// route AROUND imagePipeline.optimize(), and that is where the EXIF scrub lives
// (#516). Announce your geotagged JPEG as video/mp4 and the GPS rides along.
//
// The accepted set is a GUARANTEE, not a preference: we accept exactly the formats
// we can strip metadata from (design decision 21). Adding a format here without a
// scrubber for it silently breaks the promise the uploader makes about metadata.
// Arbitrary binary is deliberately NOT a thing — DCC is the file-transfer path
// (decision 20).

import { fileTypeFromFile } from 'file-type';
import fs from 'node:fs';
import { isFileUtf8 } from '../utils/utf8.js';
import type { ContentClass } from './uploadProviders/types.js';

export interface Classification {
  contentClass: ContentClass;
  /** Canonical MIME for the bytes. For `image` the pipeline re-derives it from the
   *  decoded image, so this is provisional; for `text`/`media` it is final. */
  mime: string;
  /** Canonical extension. NEVER the client's claim — a user's `.html` must never
   *  become the served extension. */
  ext: string;
}

export class UnsupportedTypeError extends Error {
  code = 'UNSUPPORTED_TYPE';
}

/**
 * Sniffed MIME → sharp format name.
 *
 * ⚠ This is an ALIAS MAP, not imagePipeline's FORMAT_INFO keyed by mime, and the
 * difference is load-bearing. Verified against file-type 19 with real bytes:
 *   • APNG sniffs as `image/apng` — sharp calls it `png`.
 *   • iPhone photos sniff as `image/heic` — sharp calls it `heif`.
 * A FORMAT_INFO-derived set therefore misses both: APNG would fall out of the image
 * class entirely (regressing #516's frame-preserving scrub for exactly the animated
 * format it was written for) and HEIC would stop being optimized.
 */
const IMAGE_SNIFF_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/apng',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'image/tiff',
]);

/**
 * The media we accept — i.e. the media we can clean (decision 21).
 *
 * All ISO-BMFF except mp3, which is why one box-walking scrubber covers four of the
 * five. Deliberately ABSENT: WebM/Ogg/FLAC/WAV. Not because they're dangerous — a
 * WebM comes from a browser recorder and carries a muxer name and a date, not a
 * location — but because we have no scrubber for them yet, and "everything we
 * accept, we clean" is a better rule than "everything we accept, we clean, except
 * these four". They're each a small follow-up (EBML has a `Void` element that plays
 * the same role `free` does in MP4, so the trick transfers).
 *
 * MIMEs verified against file-type 19 with real/synthesized containers — note m4a
 * is `audio/x-m4a`, NOT `audio/mp4`.
 */
const MEDIA_MIMES = new Map<string, string>([
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/x-m4v', 'm4v'],
  ['audio/x-m4a', 'm4a'],
  ['audio/mpeg', 'mp3'],
]);

/** Human list for the 415 — the error message is how a user discovers the policy. */
export const ACCEPTED_SUMMARY = 'images, text, and audio/video (mp4, mov, m4v, m4a, mp3)';

/**
 * Sniffed types that mean "this is text, I just recognized its dialect" — NOT a
 * container we should refuse.
 *
 * ⚠ Found the hard way: a bare `<svg>` sniffs as nothing, but a REAL SVG (what
 * Illustrator and Inkscape write) opens with `<?xml version="1.0"?>` and file-type
 * reports that as `application/xml`. Lumping it in with pdf/zip would have turned
 * every real SVG upload — which works today — into a 415. These fall through to the
 * text/SVG logic below and get decided there.
 */
const TEXTISH_SNIFF = new Set(['application/xml', 'text/xml']);

/** file-type THROWS (End-Of-Stream) on a file too short to finish parsing a
 *  signature it started to recognize — it doesn't just return undefined. A
 *  truncated upload must not become a 500; "couldn't identify it" is the same
 *  answer as "no signature", and the UTF-8 check below decides what to do next. */
async function sniffType(path: string): Promise<{ mime: string; ext: string } | undefined> {
  try {
    return await fileTypeFromFile(path);
  } catch {
    return undefined;
  }
}

// SVG is invisible to file-type (it's XML, not magic bytes), so it has to be
// probed for. Without this an SVG would silently reclassify image → text, which
// changes self-host's SVG passthrough and turns hosted's deliberate SVG rejection
// into a silent .txt accept.
const SVG_PROBE_BYTES = 1024;

async function looksLikeSvg(path: string): Promise<boolean> {
  const fh = await fs.promises.open(path, 'r');
  try {
    const buf = Buffer.alloc(SVG_PROBE_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SVG_PROBE_BYTES, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    return /<svg[\s>]/i.test(head);
  } finally {
    await fh.close();
  }
}

/**
 * Classify an uploaded file. Throws UnsupportedTypeError (→ 415) for anything
 * outside the accepted set.
 *
 * `claimedMime` is the client's multipart Content-Type. It is untrusted, and it is
 * used for exactly one decision — see looksLikeSvg's caller below.
 */
export async function classifyUpload(path: string, claimedMime: string): Promise<Classification> {
  const sniff = await sniffType(path);

  if (sniff) {
    if (IMAGE_SNIFF_MIMES.has(sniff.mime)) {
      // The pipeline re-derives the real mime/ext from the decoded image (and will
      // 415 it itself if sharp can't read it), so these are provisional.
      return { contentClass: 'image', mime: sniff.mime, ext: sniff.ext };
    }

    const mediaExt = MEDIA_MIMES.get(sniff.mime);
    if (mediaExt) {
      return { contentClass: 'media', mime: sniff.mime, ext: mediaExt };
    }

    // A recognized container we don't accept: pdf, zip, exe, webm, an image sharp
    // can't read (bmp/ico)… all one answer. TEXTISH_SNIFF is the exception — it
    // falls through to the text/SVG logic below.
    if (!TEXTISH_SNIFF.has(sniff.mime)) {
      throw new UnsupportedTypeError(
        `${sniff.mime} files are not accepted — Lurker takes ${ACCEPTED_SUMMARY}`,
      );
    }
  }

  // No binary signature: text-ish, or unknown. Requiring the WHOLE file to be valid
  // UTF-8 (not just a window) is what stops "claim text/plain" from smuggling
  // arbitrary bytes through as a .txt.
  if (await isFileUtf8(path)) {
    // The ONE place the client's claim is consulted. An SVG picked from a file
    // dialog arrives as image/svg+xml; the long-message → .txt flow ALWAYS claims
    // text/plain, so this guard keeps it from being hijacked into the image path
    // when someone pastes raw SVG markup into the composer. Neither direction is a
    // bypass: a real image would have sniffed above, and a text file misrouted to
    // sharp simply fails to decode and 415s.
    if (claimedMime !== 'text/plain' && (await looksLikeSvg(path))) {
      return { contentClass: 'image', mime: 'image/svg+xml', ext: 'svg' };
    }
    return { contentClass: 'text', mime: 'text/plain', ext: 'txt' };
  }

  throw new UnsupportedTypeError(
    `this file type is not accepted — Lurker takes ${ACCEPTED_SUMMARY}`,
  );
}
