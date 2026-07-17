// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// JWT minting for the native push providers (#490).
//
// Both APNs and FCM boil down to the same move: hold a long-lived secret, mint a
// short-lived signed token from it, cache the token, refresh before it expires.
// Only the algorithm and the claims differ — APNs signs its own bearer with an
// ES256 .p8 key, FCM signs an RS256 assertion it then trades with Google for an
// OAuth2 access token.
//
// No dependency for this. Node's crypto signs both, and the one detail that
// usually pushes people to a JWT library — that ES256 wants the raw r||s
// signature while Node defaults to DER for EC keys — is just
// `dsaEncoding: 'ieee-p1363'`.

import crypto from 'crypto';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Sign a JWT. `alg` picks both the header and the signature encoding: ES256 for
 * an EC P-256 key (APNs), RS256 for an RSA key (FCM service accounts).
 */
export function signJwt(
  alg: 'ES256' | 'RS256',
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKeyPem: string,
): string {
  const encodedHeader = b64url(JSON.stringify({ alg, typ: 'JWT', ...header }));
  const encodedClaims = b64url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = crypto.createSign('SHA256').update(signingInput).sign({
    key: privateKeyPem,
    // ES256 requires the raw 64-byte r||s pair (RFC 7518). Node emits DER for EC
    // keys by default, which APNs rejects as a malformed token. Ignored for RSA.
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * A short-lived token with a refresh-before-expiry cache.
 *
 * Both providers punish over-minting — APNs rejects a provider token refreshed
 * more than once every 20 minutes with TooManyProviderTokenUpdates, and Google
 * rate-limits the OAuth2 endpoint — so the cache isn't just an optimization.
 * `mint` is only called when the cached token is missing or close enough to
 * expiry to be worth replacing.
 */
export class TokenCache {
  private token: string | null = null;
  private expiresAtMs = 0;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly mint: () => Promise<{ token: string; lifetimeSeconds: number }>,
    /** Refresh this long before actual expiry, so a token can't die in flight. */
    private readonly skewSeconds = 300,
  ) {}

  async get(nowMs: number = Date.now()): Promise<string> {
    if (this.token && nowMs < this.expiresAtMs) return this.token;
    // A push fans out to every device at once, so without this a user with five
    // phones would mint five tokens concurrently on the first push after expiry —
    // which is exactly what APNs' TooManyProviderTokenUpdates punishes.
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const { token, lifetimeSeconds } = await this.mint();
        this.token = token;
        this.expiresAtMs = nowMs + Math.max(0, lifetimeSeconds - this.skewSeconds) * 1000;
        return token;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Drop the cached token — e.g. after the provider rejects it as invalid. */
  reset(): void {
    this.token = null;
    this.expiresAtMs = 0;
  }
}
