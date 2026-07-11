// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared storage-key builder for drivers that mint their own keys (`mintsKeys`
// — s3, local). Ported from the JawshTheDark/lurker fork's buildObjectKey so the
// sanitization rule lives in exactly ONE place rather than being re-derived per
// driver. No P0 driver mints keys yet; this is the foundation the local (P1) and
// s3 (P2) drivers + preserve-original-filename (#517) build on. Unit-tested so it
// isn't dead code.
//
// Security invariants (see design §5.2):
//   - The random segment LOCATES the file; the trailing original name is
//     decorative. A traversal attempt in the name can never escape the key.
//   - The extension always comes from the pipeline output, never the client's
//     claim — callers pass a validated `ext`.
//   - Dot-only segments ("..", ".") collapse to a fallback so a proxy can't be
//     tricked into path traversal.

import { randomBytes } from 'crypto';

// 48 bits of randomness — matches the fork; ample for non-guessable, non-
// enumerable keys at this scale.
const RANDOM_BYTES = 6;
const SEGMENT_MAX = 96;
// Extension length cap. Keeps a minted key within what the local serving route's
// key regex accepts (routes/localUploads.ts `KEY_RE`, [a-z0-9]{1,16}) so a file
// we wrote can never be un-servable; also a sane bound for the s3 driver. Real
// extensions are a few chars — this only ever trims a pathological input.
const EXT_MAX = 16;

/** Random, URL-safe, non-guessable id used as the locating segment of a key. */
export function randomId(): string {
  return randomBytes(RANDOM_BYTES).toString('hex');
}

/**
 * Sanitize an arbitrary filename basename into a single safe path segment:
 * `[A-Za-z0-9._-]` only, length-capped, leading/trailing separators trimmed,
 * dot-only results dropped to `fallback`.
 */
export function sanitizeSegment(name: string, fallback = 'file'): string {
  let s = (name || '').replace(/[^A-Za-z0-9._-]+/g, '-');
  s = s.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  if (s === '' || /^\.+$/.test(s)) return fallback;
  if (s.length > SEGMENT_MAX) s = s.slice(0, SEGMENT_MAX);
  return s;
}

export interface BuildObjectKeyOpts {
  // Optional leading namespace, e.g. 'thumbs'. Slashes trimmed.
  prefix?: string;
  // Extension from the pipeline output (no leading dot); sanitized to alnum.
  ext: string;
  // When set, the original basename is preserved as a cosmetic trailing segment
  // (preserve-original-filename, #517). Omit for the default random-only key.
  originalBasename?: string;
}

/**
 * Build a storage key. Shapes (matching The Lounge's `<random>/<name>` trick):
 *   default:  {prefix}/{random}.{ext}
 *   preserve: {prefix}/{random}/{sanitized-basename}.{ext}
 */
export function buildObjectKey({ prefix, ext, originalBasename }: BuildObjectKeyOpts): string {
  const rnd = randomId();
  const cleanExt =
    (ext || 'bin')
      .replace(/[^A-Za-z0-9]+/g, '')
      .toLowerCase()
      .slice(0, EXT_MAX) || 'bin';
  const p = prefix ? `${prefix.replace(/^\/+|\/+$/g, '')}/` : '';
  if (originalBasename != null && originalBasename !== '') {
    const base = sanitizeSegment(originalBasename.replace(/\.[^.]+$/, ''), 'file');
    return `${p}${rnd}/${base}.${cleanExt}`;
  }
  return `${p}${rnd}.${cleanExt}`;
}
