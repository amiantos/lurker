// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createHash, randomBytes } from 'crypto';
import db from './index.js';

// Admin-issued, single-use account recovery links (#855). Lurker accounts carry
// no email address, so there is nothing a self-service "forgot password" flow
// could verify a request against. Instead an admin issues a link for a specific
// account and hands it over out of band; redeeming it sets a password or
// enrolls a passkey.
//
// Only the SHA-256 of the token is persisted -- the raw value lives in the link
// and nowhere else, so reading this table cannot recover an account. The token
// is 32 random bytes, so an unsalted hash is enough: unlike a password it isn't
// guessable, and lookup stays a single indexed hit.
//
// expires_at is an ISO-8601 UTC string (lexicographically ordered) compared
// against a caller-supplied `now`, so expiry is directly unit-testable.

// Hand-delivered over IRC/Signal/in person rather than emailed, so this is a day
// rather than the control plane's hour.
const TTL_MS = 24 * 60 * 60 * 1000;

/** A recovery link as the admin panel sees it. Never includes the token. */
export interface RecoveryTokenInfo {
  userId: number;
  createdBy: number | null;
  expiresAt: string;
  createdAt: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a recovery link for `userId` and return the RAW token to put in the URL.
 * Only the hash is stored, and only the caller ever sees this value.
 *
 * Any outstanding link for the account is replaced: user_id is UNIQUE, so the
 * upsert is what "issuing a new link invalidates the old one" means.
 */
export function createRecoveryToken(
  userId: number,
  createdBy: number | null,
  now = Date.now(),
): string {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO account_recovery_tokens (token_hash, user_id, created_by, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       created_by = excluded.created_by,
       expires_at = excluded.expires_at,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(hashToken(token), userId, createdBy, expiresAt);
  return token;
}

/**
 * Look up a token without spending it, for the landing page's status probe.
 * Returns null for a token that is unknown OR expired -- the page shows the same
 * dead end either way, and separating them would let a caller confirm that a
 * token was once real.
 */
export function findLiveRecoveryToken(
  token: string | null | undefined,
  now = Date.now(),
): RecoveryTokenInfo | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT user_id AS userId, created_by AS createdBy,
              expires_at AS expiresAt, created_at AS createdAt
         FROM account_recovery_tokens
        WHERE token_hash = ? AND expires_at > ?`,
    )
    .get(hashToken(token), new Date(now).toISOString()) as RecoveryTokenInfo | undefined;
  return row ?? null;
}

/**
 * Atomically spend a live token, returning the user id if THIS call spent it and
 * null otherwise. Check-and-spend is one guarded statement, so two simultaneous
 * redemptions cannot both win. Deleting the row IS the single-use rule: there is
 * no spent-but-present state for a later read to misjudge.
 */
export function consumeRecoveryToken(token: string, now = Date.now()): number | null {
  const row = db
    .prepare(
      `DELETE FROM account_recovery_tokens
        WHERE token_hash = ? AND expires_at > ?
      RETURNING user_id AS userId`,
    )
    .get(hashToken(token), new Date(now).toISOString()) as { userId: number } | undefined;
  return row?.userId ?? null;
}

/** The outstanding link for an account, if any. Powers the admin panel badge. */
export function getRecoveryTokenForUser(
  userId: number,
  now = Date.now(),
): RecoveryTokenInfo | null {
  const row = db
    .prepare(
      `SELECT user_id AS userId, created_by AS createdBy,
              expires_at AS expiresAt, created_at AS createdAt
         FROM account_recovery_tokens
        WHERE user_id = ? AND expires_at > ?`,
    )
    .get(userId, new Date(now).toISOString()) as RecoveryTokenInfo | undefined;
  return row ?? null;
}

/** Revoke an account's outstanding link. True if there was one to revoke. */
export function deleteRecoveryTokensForUser(userId: number): boolean {
  const info = db.prepare('DELETE FROM account_recovery_tokens WHERE user_id = ?').run(userId);
  return info.changes > 0;
}

/**
 * Drop expired rows. Nothing depends on this for correctness -- every read
 * already filters on expires_at -- it just keeps a dead row from occupying the
 * one slot an account gets and showing up in a raw table dump.
 */
export function purgeExpiredRecoveryTokens(now = Date.now()): void {
  db.prepare('DELETE FROM account_recovery_tokens WHERE expires_at <= ?').run(
    new Date(now).toISOString(),
  );
}
