// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Signed capabilities for the byte proxy.
//
// The proxy endpoint fetches a URL and streams it back, which is a description
// of an open proxy unless something constrains which URLs it will accept. That
// something is this: the server mints a token during resolve, after the URL has
// already passed the SSRF guard, and the proxy will serve nothing else. A client
// can only ever REPLAY a decision the server already made — it has no way to
// author one, because it doesn't have the key.
//
// This is defence in depth, not the only defence. The proxy is also
// authenticated, and it re-runs the full guard at connect time, because the DNS
// answer that was safe at resolve time may not be safe now. The token's job is
// narrower: it stops the endpoint from being a general-purpose fetcher for
// anyone who already has a session.
//
// The key is DERIVED from the session secret rather than being it. They have
// different lifetimes and different blast radii — rotating the session secret
// should invalidate sessions, and it will also invalidate outstanding proxy
// tokens, but the reverse coupling (a proxy token being usable as session
// material) must not exist. HKDF with a distinct label is what keeps that true.

import crypto from 'node:crypto';
import { resolveSessionSecret } from '../utils/sessionSecret.js';

const INFO = Buffer.from('lurker-media-proxy-v1');

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (!cachedKey) {
    const { secret } = resolveSessionSecret();
    cachedKey = Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), INFO, 32),
    );
  }
  return cachedKey;
}

/** Test-only: drop the cached key so a suite can swap the session secret. */
export function resetProxyKeyCache(): void {
  cachedKey = null;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', key()).update(payload).digest('base64url');
}

/** Mint a proxy token for a URL the caller has already vetted. */
export function mintProxyToken(url: string): string {
  const payload = Buffer.from(url, 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/**
 * Recover the URL from a token, or null if the signature doesn't check out.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — and a wrong-length signature is rejected without leaking anything,
 * since the length of an HMAC-SHA256 is not a secret.
 */
export function verifyProxyToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = sign(payload);
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return null;

  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
