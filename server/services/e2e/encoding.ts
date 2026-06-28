// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared low-level encoding helpers for the e2e modules.
//
// Node's `Buffer.from(s, 'base64'|'base64url')` silently drops invalid
// characters and tolerates bad padding, whereas repartee's Rust uses strict
// base64 engines that reject such input. These decoders validate the alphabet
// and shape first and return `null` on anything the reference would reject, so
// each caller can surface the right `E2eError` kind. They keep the divergence
// in *which malformed inputs are rejected* from leaking past the wire/handshake
// boundary (valid messages always decode identically).

/** Single shared UTF-8 encoder (avoids a `new TextEncoder()` per module). */
export const utf8 = new TextEncoder();

// Standard base64 with canonical padding; url-safe base64 with no padding.
const STD_B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const URL_B64 = /^[A-Za-z0-9_-]*$/;

/** Strict standard-base64 decode (the message wire format). `null` if invalid. */
export function tryDecodeStdBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0 || !STD_B64.test(s)) return null;
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** Strict url-safe-no-pad base64 decode (handshake fields). `null` if invalid. */
export function tryDecodeUrlBase64(s: string): Uint8Array | null {
  // A trailing single base64 char (len % 4 === 1) can never be valid.
  if (s.length % 4 === 1 || !URL_B64.test(s)) return null;
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/**
 * Parse a canonical unsigned decimal integer. Returns `null` for non-canonical
 * forms that `Number()` would otherwise accept (hex `0xa`, exponent `1e0`,
 * decimal `1.0`, any leading sign) or values beyond the safe-integer range.
 * This is slightly STRICTER than repartee's `str::parse::<u8>()`, which accepts
 * a leading `+` (e.g. "+5") — harmless, since neither side ever serializes a
 * sign, so the difference is only reachable on hand-crafted/malformed input.
 */
export function parseUintStrict(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
