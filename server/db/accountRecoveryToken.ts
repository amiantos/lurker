// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The token primitives for account recovery (#855), deliberately split from
// db/accountRecovery.ts so they can be used WITHOUT importing db/index.ts.
//
// That import is not free: db/index.ts runs the whole migration + seed pipeline
// in its module body. The server does that once at boot, which is correct — but
// tools/recovery-link.ts is documented as `docker compose exec` against a
// RUNNING server, so pulling it in would make the CLI a second process running
// migrations against a database the server is actively writing. The realistic
// failure is SQLITE_BUSY, and this tool's whole reason to exist is the
// sole-admin-locked-out emergency: the worst possible moment for it to fail.
//
// Keeping the hashing and the TTL here means the CLI can open a bare connection
// (as tools/fold-buffer-case.ts does) while both callers still agree on exactly
// what a recovery token is.

import { createHash, randomBytes } from 'crypto';

/**
 * Hand-delivered over IRC/Signal/in person rather than emailed, so this is a day
 * rather than the control plane's hour.
 */
export const RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 32 random bytes, base64url. High enough entropy that the token is not
 * guessable, which is what lets the stored form be an unsalted hash and what
 * makes failure-backoff on the redemption route pointless.
 */
export function generateRecoveryToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The stored form. Only this ever reaches the database — the raw token lives in
 * the link and nowhere else, so reading the table cannot recover an account.
 * Unsalted is fine here precisely because the input isn't guessable, and it
 * keeps lookup a single indexed hit.
 */
export function hashRecoveryToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Expiry as an ISO-8601 UTC string — lexicographically ordered, so SQLite can compare it directly. */
export function recoveryExpiresAt(now = Date.now()): string {
  return new Date(now + RECOVERY_TTL_MS).toISOString();
}
