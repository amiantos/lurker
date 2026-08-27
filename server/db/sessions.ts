// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import crypto from 'crypto';
import db from './index.js';

const SESSION_DAYS = 30;

/** A row from the `sessions` table. */
export interface Session {
  token: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

export function createSession(userId: number): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expires,
  );
  return { token, expiresAt: expires };
}

export function findSession(token: string | null | undefined): Session | null {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as
    | Session
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    deleteSession(token);
    return null;
  }
  return row;
}

export function deleteSession(token: string | null | undefined): void {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * Sign an account out everywhere. Used after an account recovery (#855): the
 * lockout that made recovery necessary is indistinguishable from a takeover, so
 * every session minted before the reset is assumed hostile. The caller mints a
 * fresh session afterwards so the device doing the recovery stays signed in.
 *
 * ⚠ This drops the session ROWS, which is what every future request and /ws
 * upgrade is checked against — but a WebSocket that is ALREADY open holds its
 * authenticated user in the socket's closure and is not re-checked, so it keeps
 * streaming until it disconnects. Closing live sockets on revocation is #567,
 * which owns the same gap for PUT /password.
 *
 * Returns the number of sessions dropped.
 */
export function deleteSessionsForUser(userId: number): number {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

export function purgeExpiredSessions(): void {
  // expires_at is written as ISO 8601 ('YYYY-MM-DDTHH:MM:SS.sssZ') while
  // datetime('now') returns SQLite-local format ('YYYY-MM-DD HH:MM:SS').
  // Lexical compare of the two formats puts ISO greater for same-day rows
  // (the literal 'T' > ' '), so wrap both sides in datetime() to normalize
  // them onto the same scale before comparing.
  db.prepare("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')").run();
}
