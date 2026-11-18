// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What IS this file? Decided from its magic bytes, on the server, every time.
//
// THE RULE: the bytes have absolute authority over the CLASS. The client's claim is
// consulted only where it cannot cause a bypass, because a real image would have been
// caught by the sniff regardless of what it was called:
//   • telling text apart from SVG among signature-less UTF-8 content
//   • naming which text dialect that content is — .txt, .md or .json (#788)
// Both answer "what do we call these bytes", never "do we take them".
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
import {
  PLAIN_TEXT,
  TEXT_DIALECT_BY_MIME,
  dialectFromFilename,
} from '../../shared/textDialects.js';
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
 * The first seven are ISO-BMFF, which is why one box-walking scrubber covers them;
 * mp3 is ID3. WebM/Matroska, Ogg, FLAC and WAV (#553) each have a scrubber of their
 * own beside it — see services/mediaScrub.ts for which. Still ABSENT, for the reason
 * those four once were: AVI, AIFF, raw AAC and the rest have no scrubber, and
 * "everything we accept, we clean" is a better rule than "everything we accept, we
 * clean, except these".
 *
 * MIMEs verified against file-type 22 (`source/index.js`, the `ftyp` switch) with
 * real and synthesized containers. file-type labels an ISO-BMFF file by its major
 * `ftyp` brand, so ONE box structure surfaces under several MIMEs we handle
 * identically:
 *   • `M4A `                → audio/x-m4a
 *   • `M4B `/`F4A `/`F4B `  → audio/mp4     (iTunes audiobooks, Flash audio)
 *   • `3g2*`                → video/3gpp2
 *   • any other `3g*`       → video/3gpp
 *   • everything else       → video/mp4     (the switch's default branch)
 *
 * ⚠ That last line is the trap: `audio/mp4` is NOT "the audio-only MIME". An
 * audio-only file with an `mp42`/`isom` brand — which is most of them — falls to the
 * default and sniffs as `video/mp4`. Only the four brands above ever produce it.
 *
 * The 3GPP entries are not theoretical. Samsung's stock voice recorder
 * (`com.sec.android.app.voicenote`) writes a `3gp4`-branded container holding AAC and
 * names the file `.m4a`, so sharing a voice memo off a Galaxy used to 415 while the
 * identical box structure under an `mp42` brand went through. The file we refused
 * carried the recorder's app fingerprint, the Android version, and a UTC offset that
 * pins the recorder's timezone — refusing it protected nobody, it just sent that
 * metadata out via some other host. walkBoxes strips all of it, size-preserving.
 *
 * m4a-ish brands serve as `.m4a`; 3GPP keeps its honest container extension.
 *
 * The #553 formats, verified the same way:
 *   • WebM and Matroska are told apart by the EBML DocType, and an audio-only WebM
 *     is still `video/webm` — same trap as `audio/mp4` above.
 *   • An Ogg file is labelled by its FIRST stream's codec. Vorbis, Speex and
 *     FLAC-in-Ogg are all `audio/ogg`; Theora and OGM are both `video/ogg`. The
 *     label is therefore not a promise that the scrubber knows the codec — it
 *     refuses FLAC-in-Ogg and OGM itself, and that refusal is the 415.
 *   • Opus sniffs as `audio/ogg; codecs=opus`, parameter and all. See
 *     CANONICAL_MEDIA_MIME.
 */
const MEDIA_MIMES = new Map<string, string>([
  ['video/mp4', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/x-m4v', 'm4v'],
  ['audio/x-m4a', 'm4a'],
  ['audio/mp4', 'm4a'],
  ['video/3gpp', '3gp'],
  ['video/3gpp2', '3g2'],
  ['audio/mpeg', 'mp3'],
  ['video/webm', 'webm'],
  ['video/matroska', 'mkv'],
  ['audio/ogg', 'ogg'],
  ['audio/ogg; codecs=opus', 'opus'],
  ['video/ogg', 'ogv'],
  ['audio/flac', 'flac'],
  ['audio/wav', 'wav'],
]);

/**
 * Sniffed MIME → the bare type we record and hand to a driver, where they differ.
 *
 * ⚠ Same reason STORED_CONTENT_TYPE below keeps its charset off the identity: a
 * driver may match the type against a list of bare ones, the uploads browser files
 * a row under a kind by its mime, and the scrubber dispatches on it. The codec
 * parameter survives where it is useful — as the `.opus` extension.
 */
const CANONICAL_MEDIA_MIME = new Map<string, string>([['audio/ogg; codecs=opus', 'audio/ogg']]);

/** What's accepted as MIME ranges, for a route that has to list them (FILEHOST's Accept-Post). */
export function acceptedMimeRanges(): string[] {
  const dialects = [...TEXT_DIALECT_BY_MIME.keys()].filter((mime) => !mime.startsWith('text/'));
  const media = new Set([...MEDIA_MIMES.keys()].map((m) => CANONICAL_MEDIA_MIME.get(m) ?? m));
  return ['image/*', 'text/*', ...dialects, ...media];
}

/** Human list for the 415 — the error message is how a user discovers the policy. */
export const ACCEPTED_SUMMARY =
  'images, text, and audio/video (mp4, mov, m4v, m4a, 3gp, 3g2, mp3, webm, mkv, ogg, opus, flac, wav)';

/**
 * Sniffed types that mean "this is text, I just recognized its dialect" — NOT a
 * container we should refuse.
 *
 * ⚠ Found the hard way: a bare `<svg>` sniffs as nothing, but a REAL SVG (what
 * Illustrator and Inkscape write) opens with `<?xml version="1.0"?>` and file-type
 * reports that as `application/xml`. Lumping it in with pdf/zip would have turned
 * every real SVG upload — which works today — into a 415. These fall through to the
 * text/SVG logic below and get decided there.
 *
 * ISO 9660 is here for the opposite reason: it's not text, but its whole signature
 * is `CD001` at byte 32769 (file-type 22.1+). A text upload that happens to have
 * those five bytes there would get a 415. Falling through keeps the pre-22.1
 * answer: the full-file UTF-8 check below decides, same as for every file with no
 * signature.
 */
const TEXTISH_SNIFF = new Set(['application/xml', 'text/xml', 'application/x-iso9660-image']);

/**
 * The text dialect table moved to shared/ — the CLIENT's paste/drop gate needs the
 * extension half for the same portability reason this file needs it, and a second
 * hand-written copy of the rule is how the two drift. The security note about what
 * may be added to it lives with the table.
 *
 * ⚠ Consulted here for exactly two things, and the ORDER matters — see the call site:
 * the mime table decides whether the SVG probe runs, and the filename table then picks
 * the label, filename FIRST.
 */

/**
 * The Content-Type to STORE for an upload, which is not always its classified mime.
 *
 * A text file served with a bare `text/plain` and no charset is decoded by whatever
 * legacy encoding the browser falls back to — Latin-1 on Safari — so a UTF-8 paste
 * comes back as `â€"` for every `—`. That is #788: the bytes are fine, the label is
 * incomplete. `routes/localUploads.ts` has always sent the parameter when serving
 * from disk; this is for the drivers that hand a stored header to someone else.
 *
 * ⚠⚠ NOT for the `dropper` driver, and not something to apply to `Classification.mime`
 * globally. Dropper matches the claim against an exact allowlist of BARE types, so a
 * `text/plain; charset=utf-8` claim 415s every text upload on the hosted service. The
 * bare mime is the identity; the charset belongs only on a header we are writing.
 *
 * JSON gets none: RFC 8259 defines no charset parameter for `application/json` and
 * mandates UTF-8 outright.
 */
const STORED_CONTENT_TYPE = new Map<string, string>([
  ['text/plain', 'text/plain; charset=utf-8'],
  ['text/markdown', 'text/markdown; charset=utf-8'],
]);

export function storedContentType(mime: string): string {
  return STORED_CONTENT_TYPE.get(mime) ?? mime;
}

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
 * `claimedMime` is the client's multipart Content-Type. It is untrusted, and it
 * decides exactly two things, both of them bounded: whether to run the SVG probe
 * (see looksLikeSvg's caller below), and which of three text dialects to label
 * signature-less UTF-8 as. It can never widen what is ACCEPTED.
 *
 * `filename` is the client's original filename, and is even more tightly bounded —
 * its extension is a fallback signal for the dialect label and nothing else. It is
 * never the served extension — see TEXT_DIALECT_BY_MIME.
 */
export async function classifyUpload(
  path: string,
  claimedMime: string,
  filename = '',
): Promise<Classification> {
  const sniff = await sniffType(path);

  if (sniff) {
    if (IMAGE_SNIFF_MIMES.has(sniff.mime)) {
      // The pipeline re-derives the real mime/ext from the decoded image (and will
      // 415 it itself if sharp can't read it), so these are provisional.
      return { contentClass: 'image', mime: sniff.mime, ext: sniff.ext };
    }

    const mediaExt = MEDIA_MIMES.get(sniff.mime);
    if (mediaExt) {
      const mime = CANONICAL_MEDIA_MIME.get(sniff.mime) ?? sniff.mime;
      return { contentClass: 'media', mime, ext: mediaExt };
    }

    // A recognized container we don't accept: pdf, zip, exe, avi, an image sharp
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
    // An SVG picked from a file dialog arrives as image/svg+xml; a claim that is
    // already a text dialect exempts it from the probe, which is what keeps the
    // long-message → .txt flow (ALWAYS text/plain) from being hijacked into the
    // image path when someone pastes raw SVG markup into the composer. Neither
    // direction is a bypass: a real image would have sniffed above, and a text file
    // misrouted to sharp simply fails to decode and 415s.
    //
    // ⚠ Decided from the CLAIM alone, before the filename is consulted at all. The
    // exemption widened from `text/plain` to the dialects together with the map, so
    // an explicitly-picked `.md` full of SVG markup stays markdown — served as
    // text/markdown it is just as inert, and calling a file the user named `.md` an
    // image is the more surprising answer.
    const claimed = TEXT_DIALECT_BY_MIME.get(claimedMime);
    if (!claimed && (await looksLikeSvg(path))) {
      return { contentClass: 'image', mime: 'image/svg+xml', ext: 'svg' };
    }
    // ⚠ FILENAME first, claim second. Backwards from what you'd expect, and the
    // reverse does not work: on a platform with no registered mime for `.md` the
    // claim arrives as `text/plain`, which is itself a dialect — so a claim-first
    // order matches it, returns `.txt`, and the filename fallback never runs in the
    // one case it exists for. The extension is also the more specific signal: it is
    // what the user named the file, where the claim is what their OS guessed about
    // it. Plain text when neither says anything.
    const dialect = dialectFromFilename(filename) ?? claimed ?? PLAIN_TEXT;
    return { contentClass: 'text', mime: dialect.mime, ext: dialect.ext };
  }

  throw new UnsupportedTypeError(
    `this file type is not accepted — Lurker takes ${ACCEPTED_SUMMARY}`,
  );
}
