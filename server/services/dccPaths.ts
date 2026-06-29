// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Destination resolution + filename safety for DCC downloads (#270). The download
// root is operator config; received files land under <root>/<username>/ so
// accounts on a shared cell never clobber each other and the auth'd download
// endpoint can scope retrieval by owner. Phase 1 supports a single root
// (LURKER_DCC_DIR); the resolver is shaped so multiple named destinations (a
// picker) become an additive change, not a reshape of stored paths.
//
// The DCC SEND filename is ATTACKER-CONTROLLED — the remote peer chooses it — so
// sanitizeDccFilename is the security boundary: its result is always a single
// path component (no separator, never '.'/'..'), so a malicious name cannot
// escape the user's directory. resolveDccDestination adds defense-in-depth by
// re-checking the joined path stays inside the user dir.

import fs from 'fs';
import path from 'path';

const MAX_FILENAME_LEN = 255;
const FALLBACK_NAME = 'dcc-download';

/** The configured DCC download root, or null when unset (downloads can't run). */
export function dccRoot(): string | null {
  const raw = (process.env.LURKER_DCC_DIR ?? '').trim();
  return raw === '' ? null : raw;
}

/**
 * Reduce an attacker-controlled DCC filename to a safe single path component:
 * take only the basename (both POSIX and Windows separators), drop control chars
 * / NUL, trim whitespace, reject bare '.'/'..', and clamp the length (preserving
 * the extension). Returns a non-empty safe name, falling back to a default when
 * nothing usable remains. The result NEVER contains a path separator.
 */
export function sanitizeDccFilename(raw: string): string {
  // Normalise Windows separators to '/', then take the basename — after this
  // there is no separator of either kind left in the string.
  let name = raw.replace(/\\/g, '/');
  name = name.slice(name.lastIndexOf('/') + 1);
  // Strip control chars (incl. NUL 0x00 and DEL 0x7f).
  name = [...name]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 0x20 && c !== 0x7f;
    })
    .join('');
  name = name.trim();
  if (name === '' || name === '.' || name === '..') return FALLBACK_NAME;
  if (name.length > MAX_FILENAME_LEN) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, MAX_FILENAME_LEN - ext.length).trimEnd() + ext;
  }
  return name;
}

/**
 * Resolve the on-disk path to write a user's download to, creating the per-user
 * directory. De-collides by appending " (n)" before the extension so a repeat
 * download never overwrites. Throws if no root is configured or — defense in
 * depth — the resolved path would somehow escape the user directory.
 */
export function resolveDccDestination(username: string, rawFilename: string): string {
  const root = dccRoot();
  if (!root) throw new Error('DCC download directory is not configured (set LURKER_DCC_DIR)');
  const userDir = path.join(root, sanitizeDccFilename(username));
  fs.mkdirSync(userDir, { recursive: true });

  const safeName = sanitizeDccFilename(rawFilename);
  let candidate = path.join(userDir, safeName);
  const rel = path.relative(userDir, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('refusing unsafe DCC destination path');
  }

  if (fs.existsSync(candidate)) {
    const ext = path.extname(safeName);
    const base = safeName.slice(0, safeName.length - ext.length);
    let n = 1;
    do {
      candidate = path.join(userDir, `${base} (${n})${ext}`);
      n += 1;
    } while (fs.existsSync(candidate));
  }
  return candidate;
}

/**
 * Whether `dir`'s filesystem has room for `bytes` plus a safety margin. Used to
 * refuse a transfer that would fill the cell disk (the offer's advertised size is
 * attacker-controlled, but the receiver also caps writes at it). Fails OPEN — if
 * statfs can't be read, we don't block the transfer.
 */
export function hasFreeSpaceFor(
  dir: string,
  bytes: number,
  marginBytes = 64 * 1024 * 1024,
): boolean {
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize >= bytes + marginBytes;
  } catch {
    return true;
  }
}
