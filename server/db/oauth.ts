// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import crypto from 'crypto';
import db from './index.js';

// Storage for the OAuth 2 authorization server (#891). A third-party client
// registers itself (RFC 7591), the member approves it in the browser, and the
// client trades the resulting code for an access token that works exactly like
// a password sign-in.
//
// Client ids are public. Every other secret here is 32 random bytes stored only
// as its SHA-256 -- the api_tokens reasoning: unguessable input makes an
// unsalted hash enough, and reading these tables yields nothing usable. Codes
// and tokens are hard-deleted when spent or revoked, so liveness is simply "the
// row exists" and no revoked-but-present state can be misread later.
//
// Timestamps are ISO-8601 UTC strings compared lexicographically against a
// caller-supplied `now`, which keeps expiry and purging unit-testable.

/** How long an issued authorization code stays redeemable. */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** How long a registration nobody has approved survives before the purge. */
export const PENDING_APP_TTL_MS = 60 * 60 * 1000;
/** Unapproved registrations allowed at once; registration answers 429 past it. */
export const MAX_PENDING_APPS = 1000;

export function generateSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSecret(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** A registered client. */
export interface OAuthApp {
  id: number;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  redirectUris: string[];
  createdAt: string;
  firstAuthorizedAt: string | null;
}

interface AppRow {
  id: number;
  client_id: string;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string;
  created_at: string;
  first_authorized_at: string | null;
}

function rowToApp(row: AppRow | undefined): OAuthApp | null {
  if (!row) return null;
  let redirectUris: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.redirect_uris);
    if (Array.isArray(parsed)) {
      redirectUris = parsed.filter((u): u is string => typeof u === 'string');
    }
  } catch {
    // A corrupt row matches no redirect, which refuses every authorization.
  }
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientUri: row.client_uri,
    redirectUris,
    createdAt: row.created_at,
    firstAuthorizedAt: row.first_authorized_at,
  };
}

export function createApp(
  input: { clientName: string; clientUri: string | null; redirectUris: string[] },
  now = Date.now(),
): OAuthApp {
  const clientId = generateSecret();
  const createdAt = iso(now);
  const info = db
    .prepare(
      `INSERT INTO oauth_apps (client_id, client_name, client_uri, redirect_uris, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      clientId,
      input.clientName,
      input.clientUri,
      JSON.stringify(input.redirectUris),
      createdAt,
    );
  return {
    id: Number(info.lastInsertRowid),
    clientId,
    clientName: input.clientName,
    clientUri: input.clientUri,
    redirectUris: input.redirectUris,
    createdAt,
    firstAuthorizedAt: null,
  };
}

export function findAppByClientId(clientId: string): OAuthApp | null {
  return rowToApp(
    db.prepare('SELECT * FROM oauth_apps WHERE client_id = ?').get(clientId) as AppRow | undefined,
  );
}

/** Registrations nobody has approved yet -- the only ones an anonymous caller can pile up. */
export function countPendingApps(): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM oauth_apps WHERE first_authorized_at IS NULL')
    .get() as { n: number };
  return row.n;
}

/**
 * Issue an authorization code for an approval, returning the RAW code. Also
 * marks the app as approved at least once, which is what exempts it from the
 * pending-registration purge.
 */
export function createCode(
  input: { appId: number; userId: number; redirectUri: string; codeChallenge: string },
  now = Date.now(),
): string {
  const code = generateSecret();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO oauth_codes (code_hash, app_id, user_id, redirect_uri, code_challenge, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      hashSecret(code),
      input.appId,
      input.userId,
      input.redirectUri,
      input.codeChallenge,
      iso(now + CODE_TTL_MS),
    );
    db.prepare(
      'UPDATE oauth_apps SET first_authorized_at = ? WHERE id = ? AND first_authorized_at IS NULL',
    ).run(iso(now), input.appId);
  })();
  return code;
}

export interface ConsumedCode {
  appId: number;
  userId: number;
  redirectUri: string;
  codeChallenge: string;
}

/**
 * Spend a live code, returning what it was bound to if THIS call spent it.
 *
 * One auto-committing statement, like consumeRecoveryToken: two simultaneous
 * exchanges cannot both win, and the caller checks the client, redirect and
 * PKCE verifier only AFTER the code is gone. A code that fails those checks has
 * been seen by someone it wasn't issued to, so burning it is the point. Never
 * wrap this in a transaction that throws on a failed check -- the rollback would
 * hand the code back.
 */
export function consumeCode(code: string, now = Date.now()): ConsumedCode | null {
  const row = db
    .prepare(
      `DELETE FROM oauth_codes WHERE code_hash = ? AND expires_at > ?
       RETURNING app_id AS appId, user_id AS userId, redirect_uri AS redirectUri,
                 code_challenge AS codeChallenge`,
    )
    .get(hashSecret(code), iso(now)) as ConsumedCode | undefined;
  return row ?? null;
}

/** Mint an access token, returning the RAW value. It never expires; revoking deletes it. */
export function createToken(appId: number, userId: number, now = Date.now()): string {
  const token = generateSecret();
  db.prepare(
    'INSERT INTO oauth_tokens (token_hash, app_id, user_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(hashSecret(token), appId, userId, iso(now));
  return token;
}

export interface OAuthToken {
  id: number;
  appId: number;
  userId: number;
}

export function findTokenByRaw(raw: string): OAuthToken | null {
  const row = db
    .prepare('SELECT id, app_id AS appId, user_id AS userId FROM oauth_tokens WHERE token_hash = ?')
    .get(hashSecret(raw)) as OAuthToken | undefined;
  return row ?? null;
}

// Throttled in SQL, like api_tokens: a busy client doesn't rewrite the row on
// every request. ISO on both sides of the comparison so it orders correctly.
const touchStmt = db.prepare(`
  UPDATE oauth_tokens
     SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = ?
     AND (last_used_at IS NULL
          OR last_used_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds'))
`);

export function touchTokenLastUsed(id: number): void {
  touchStmt.run(id);
}

export interface DeletedToken {
  id: number;
  userId: number;
}

/** Revoke by raw value (sign-out with the token itself). */
export function deleteTokenByRaw(raw: string): DeletedToken | null {
  const row = db
    .prepare('DELETE FROM oauth_tokens WHERE token_hash = ? RETURNING id, user_id AS userId')
    .get(hashSecret(raw)) as DeletedToken | undefined;
  return row ?? null;
}

/** Revoke by raw value, but only a token issued to `clientId` (RFC 7009). */
export function deleteTokenForClient(raw: string, clientId: string): DeletedToken | null {
  const row = db
    .prepare(
      `DELETE FROM oauth_tokens
        WHERE token_hash = ? AND app_id = (SELECT id FROM oauth_apps WHERE client_id = ?)
       RETURNING id, user_id AS userId`,
    )
    .get(hashSecret(raw), clientId) as DeletedToken | undefined;
  return row ?? null;
}

/**
 * Revoke one app for one member: its tokens AND any unexchanged codes, which
 * would otherwise mint a fresh token minutes after the revoke. Returns the
 * deleted token ids so the caller can close the sockets they opened.
 */
export function deleteOAuthForApp(userId: number, appId: number): number[] {
  return db.transaction(() => {
    db.prepare('DELETE FROM oauth_codes WHERE user_id = ? AND app_id = ?').run(userId, appId);
    const rows = db
      .prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND app_id = ? RETURNING id')
      .all(userId, appId) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  })();
}

/** Revoke every app for a member (account recovery). Codes too, for the same reason. */
export function deleteOAuthForUser(userId: number): number[] {
  return db.transaction(() => {
    db.prepare('DELETE FROM oauth_codes WHERE user_id = ?').run(userId);
    const rows = db
      .prepare('DELETE FROM oauth_tokens WHERE user_id = ? RETURNING id')
      .all(userId) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  })();
}

/** An app the member has approved and still holds a token for. */
export interface AuthorizedApp {
  id: number;
  name: string;
  clientUri: string | null;
  authorizedAt: string;
  lastUsedAt: string | null;
}

export function listAuthorizedApps(userId: number): AuthorizedApp[] {
  return db
    .prepare(
      `SELECT a.id AS id, a.client_name AS name, a.client_uri AS clientUri,
              MIN(t.created_at) AS authorizedAt, MAX(t.last_used_at) AS lastUsedAt
         FROM oauth_tokens t
         JOIN oauth_apps a ON a.id = t.app_id
        WHERE t.user_id = ?
        GROUP BY a.id
        ORDER BY authorizedAt DESC`,
    )
    .all(userId) as AuthorizedApp[];
}

/**
 * Drop expired codes and registrations nobody approved in time. Nothing reads a
 * stale code (consumeCode filters on expiry); the app half is what bounds the
 * table against anonymous registration.
 */
export function purgeOAuth(now = Date.now()): { codes: number; apps: number } {
  const codes = db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(iso(now)).changes;
  const apps = db
    .prepare('DELETE FROM oauth_apps WHERE first_authorized_at IS NULL AND created_at <= ?')
    .run(iso(now - PENDING_APP_TTL_MS)).changes;
  return { codes, apps };
}
