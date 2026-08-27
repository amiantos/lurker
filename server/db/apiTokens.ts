// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import crypto from 'crypto';
import db from './index.js';

/** A row from `api_tokens` (active-only view, without token_hash). */
export interface ApiToken {
  id: number;
  userId: number;
  name: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Summary row returned by listForUser (excludes userId). */
export interface ApiTokenSummary {
  id: number;
  name: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Result returned by createToken — includes the one-time raw token. */
export interface CreateTokenResult {
  id: number;
  userId: number;
  name: string;
  scope: string;
  token: string;
}

// Raw token is 32 random bytes, base64url-encoded — high enough entropy that
// the storage hash can be a plain SHA-256 (no salt, no Argon2). The raw value
// is returned once on create and never persisted; lookups always hash the
// presented bearer first.
function generateRawToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

const VALID_SCOPES = new Set(['read', 'read-write']);

const insertStmt = db.prepare(`
  INSERT INTO api_tokens (user_id, name, token_hash, scope)
  VALUES (@userId, @name, @tokenHash, @scope)
`);

const findByHashStmt = db.prepare(`
  SELECT id, user_id AS userId, name, scope, created_at AS createdAt,
         last_used_at AS lastUsedAt, revoked_at AS revokedAt
  FROM api_tokens
  WHERE token_hash = ? AND revoked_at IS NULL
`);

const listForUserStmt = db.prepare(`
  SELECT id, name, scope, created_at AS createdAt,
         last_used_at AS lastUsedAt, revoked_at AS revokedAt
  FROM api_tokens
  WHERE user_id = ?
  ORDER BY id DESC
`);

const revokeStmt = db.prepare(`
  UPDATE api_tokens
     SET revoked_at = datetime('now')
   WHERE id = ? AND user_id = ? AND revoked_at IS NULL
`);

// Mirror users.touchUserLastSeen: throttle in SQL so a busy client doesn't
// rewrite the row on every call. No in-memory Map needed.
const touchStmt = db.prepare(`
  UPDATE api_tokens
     SET last_used_at = datetime('now')
   WHERE id = ?
     AND (last_used_at IS NULL OR last_used_at < datetime('now', '-60 seconds'))
`);

export function createToken({
  userId,
  name,
  scope,
}: {
  userId: number;
  name: string;
  scope: string;
}): CreateTokenResult {
  if (!VALID_SCOPES.has(scope)) throw new Error(`invalid scope: ${scope}`);
  const trimmedName = (name || '').trim();
  if (!trimmedName) throw new Error('name required');
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const info = insertStmt.run({ userId, name: trimmedName, tokenHash, scope });
  return {
    id: Number(info.lastInsertRowid),
    userId,
    name: trimmedName,
    scope,
    token: raw,
  };
}

export function findActiveByHash(tokenHash: string): ApiToken | null {
  return (findByHashStmt.get(tokenHash) as ApiToken | undefined) ?? null;
}

export function listForUser(userId: number): ApiTokenSummary[] {
  return listForUserStmt.all(userId) as ApiTokenSummary[];
}

export function revoke(id: number, userId: number): boolean {
  return revokeStmt.run(id, userId).changes > 0;
}

/**
 * Revoke every live token for a user, returning how many were revoked.
 *
 * For account recovery (#855): an API token is an independent bearer credential
 * that outlives any session, so someone who held the account could mint one and
 * keep read-write REST/MCP/IRC access straight through a recovery. "Every
 * session predating the recovery is assumed hostile" has to include these.
 * Soft-revokes, like revoke() — the row stays as a record of what was cut off.
 */
export function revokeAllForUser(userId: number): number {
  return db
    .prepare(
      `UPDATE api_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .run(userId).changes;
}

export function touchLastUsed(id: number): void {
  touchStmt.run(id);
}
