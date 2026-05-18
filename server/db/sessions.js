// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import crypto from 'crypto';
import db from './index.js';

const SESSION_DAYS = 30;

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expiresAt: expires };
}

export function findSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    deleteSession(token);
    return null;
  }
  return row;
}

export function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function purgeExpiredSessions() {
  // expires_at is written as ISO 8601 ('YYYY-MM-DDTHH:MM:SS.sssZ') while
  // datetime('now') returns SQLite-local format ('YYYY-MM-DD HH:MM:SS').
  // Lexical compare of the two formats puts ISO greater for same-day rows
  // (the literal 'T' > ' '), so wrap both sides in datetime() to normalize
  // them onto the same scale before comparing.
  db.prepare("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')").run();
}
