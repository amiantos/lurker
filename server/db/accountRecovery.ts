// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { insertCredential, deleteAllForUser as deleteAllPasskeys } from './webauthnCredentials.js';
import { setPasswordHash } from './users.js';
import type { InsertCredentialFields } from './webauthnCredentials.js';
import {
  generateRecoveryToken,
  hashRecoveryToken,
  recoveryExpiresAt,
} from './accountRecoveryToken.js';

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

/** A recovery link as the admin panel sees it. Never includes the token. */
export interface RecoveryTokenInfo {
  userId: number;
  createdBy: number | null;
  expiresAt: string;
  createdAt: string;
}

/**
 * Issue a recovery link for `userId`, returning the RAW token to put in the URL
 * along with its expiry. Only the hash is stored, and only the caller ever sees
 * the raw value.
 *
 * Any outstanding link for the account is replaced: user_id is UNIQUE, so the
 * upsert is what "issuing a new link invalidates the old one" means.
 */
export function createRecoveryToken(
  userId: number,
  createdBy: number | null,
  now = Date.now(),
): { token: string; expiresAt: string } {
  const token = generateRecoveryToken();
  const expiresAt = recoveryExpiresAt(now);
  db.prepare(
    `INSERT INTO account_recovery_tokens (token_hash, user_id, created_by, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       created_by = excluded.created_by,
       expires_at = excluded.expires_at,
       created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(hashRecoveryToken(token), userId, createdBy, expiresAt);
  // Returned rather than left for the caller to re-read: a concurrent revoke
  // between the write and a follow-up SELECT would hand back nothing, and by
  // then the raw token exists only in this local — the response would be lost
  // AND the previous link already replaced.
  return { token, expiresAt };
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
    .get(hashRecoveryToken(token), new Date(now).toISOString()) as RecoveryTokenInfo | undefined;
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
    .get(hashRecoveryToken(token), new Date(now).toISOString()) as { userId: number } | undefined;
  return row?.userId ?? null;
}

/**
 * Spend a recovery link, clear every OTHER credential on the account, and set
 * the new password — all atomically. Returns the user id, or null if the link
 * was already gone.
 *
 * The credential wipe is the point, not housekeeping. Recovery exists because an
 * account may have been taken over, and an attacker who enrolled a passkey keeps
 * a way in that a password change cannot touch. Redeeming therefore leaves
 * exactly one credential: the one just established.
 */
export function spendRecoveryAndSetPassword(
  token: string,
  passwordHash: string,
  now = Date.now(),
): number | null {
  const run = db.transaction((): number | null => {
    const userId = consumeRecoveryToken(token, now);
    if (userId === null) return null;
    deleteAllPasskeys(userId);
    setPasswordHash(userId, passwordHash);
    return userId;
  });
  return run();
}

/**
 * Spend a recovery link and enroll a passkey as ONE atomic step, returning the
 * user id on success or null if the link was already gone.
 *
 * Also clears the password and every pre-existing passkey, for the same reason
 * as above: an attacker who took the account over by SETTING a password would
 * otherwise still know it and be back in seconds. A password is pure knowledge,
 * so the "can't be used without the authenticator" argument that once exempted
 * credentials here does not cover it.
 *
 * They cannot be separate statements. `webauthn_credentials.credential_id` is
 * UNIQUE across the whole instance, while the ceremony's excludeCredentials only
 * covers the account being recovered — so an authenticator already enrolled on
 * some OTHER account here passes the ceremony and then fails the insert. Split
 * apart, that leaves the link spent and no credential written: the member's one
 * link is gone and they are still locked out. Rolled back together, the link
 * survives and they can retry with a different authenticator.
 *
 * `expectedUserId` pins the link to the account the challenge was issued for, so
 * a challenge cannot be redirected onto a different account's link.
 *
 * Throws whatever the insert throws (SQLITE_CONSTRAINT for a duplicate
 * credential); the caller turns that into a 409.
 */
export function spendRecoveryAndEnroll(
  token: string,
  expectedUserId: number,
  credential: Omit<InsertCredentialFields, 'userId'>,
  now = Date.now(),
): number | null {
  const run = db.transaction((): number | null => {
    // Both rejections are checked BEFORE anything is written. A plain `return`
    // from a better-sqlite3 transaction COMMITS — only a throw rolls back — so a
    // bail-out after the consume would spend the link on its way out. Order is
    // the guard here, not the transaction.
    const info = findLiveRecoveryToken(token, now);
    if (!info || info.userId !== expectedUserId) return null;
    const userId = consumeRecoveryToken(token, now);
    if (userId === null) return null;
    // Before the insert, so a duplicate-credential throw rolls the wipe back too
    // and the member keeps everything they had.
    deleteAllPasskeys(userId);
    setPasswordHash(userId, null);
    // The one statement that can fail. Its throw is what rolls all of this back.
    insertCredential({ ...credential, userId });
    return userId;
  });
  return run();
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

/**
 * Every account with a live link, as {userId → expiresAt}. One query for the
 * admin roster; the per-user getRecoveryTokenForUser is for single-row callers.
 */
export function listRecoveryExpiries(now = Date.now()): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT user_id AS userId, expires_at AS expiresAt
         FROM account_recovery_tokens
        WHERE expires_at > ?`,
    )
    .all(new Date(now).toISOString()) as { userId: number; expiresAt: string }[];
  return new Map(rows.map((r) => [r.userId, r.expiresAt]));
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
