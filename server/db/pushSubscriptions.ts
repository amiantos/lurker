// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** A row from the `push_subscriptions` table. */
export interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  enabled: number;
  created_at: string;
  last_seen_at: string;
  fail_count: number;
}

/** Projected push subscription with boolean `enabled`. */
export interface PushSubscription {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  enabled: boolean;
  created_at: string;
  last_seen_at: string;
  fail_count: number;
}

function rowToSub(row: PushSubscriptionRow | undefined): PushSubscription | null {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    user_agent: row.user_agent,
    enabled: !!row.enabled,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    fail_count: row.fail_count ?? 0,
  };
}

export function listEnabledForUser(userId: number): PushSubscription[] {
  return (
    db
      .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? AND enabled = 1')
      .all(userId) as PushSubscriptionRow[]
  )
    .map(rowToSub)
    .filter((s): s is PushSubscription => s !== null);
}

// Cheap "does this user have any push device?" probe — a single indexed lookup,
// no row projection. Lets the push path skip the work it would otherwise do
// (e.g. computing the app-icon badge total) for users who never subscribed,
// since deliver() would no-op on an empty subscription set anyway.
export function hasEnabledForUser(userId: number): boolean {
  return !!db
    .prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND enabled = 1 LIMIT 1')
    .get(userId);
}

export function listAllForUser(userId: number): PushSubscription[] {
  return (
    db
      .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id')
      .all(userId) as PushSubscriptionRow[]
  )
    .map(rowToSub)
    .filter((s): s is PushSubscription => s !== null);
}

export function getByEndpoint(endpoint: string): PushSubscription | null {
  return rowToSub(
    db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as
      | PushSubscriptionRow
      | undefined,
  );
}

// Push endpoint URLs persist per browser/PushManager — when two users log
// into the same browser, the same endpoint comes back from subscribe(). A
// blind UPDATE would silently rebind it to whichever user enabled most
// recently, stealing the other user's notifications. Refuse instead; the
// previous owner must disable push on their session before a new user can
// claim it. Returns { ok, sub? } on success or { ok: false, error } on a
// cross-user collision.
export function upsertSubscription(
  userId: number,
  {
    endpoint,
    p256dh,
    auth,
    userAgent,
  }: { endpoint: string; p256dh: string; auth: string; userAgent?: string | null },
): { ok: true; sub: PushSubscription | null } | { ok: false; error: string } {
  const existing = getByEndpoint(endpoint);
  if (existing && existing.user_id !== userId) {
    return { ok: false, error: 'endpoint_owned_by_other_user' };
  }
  if (existing) {
    db.prepare(
      `
      UPDATE push_subscriptions
      SET p256dh = ?, auth = ?, user_agent = COALESCE(?, user_agent),
          enabled = 1, fail_count = 0,
          last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE endpoint = ?
    `,
    ).run(p256dh, auth, userAgent || null, endpoint);
    return { ok: true, sub: getByEndpoint(endpoint) };
  }
  db.prepare(
    `
    INSERT INTO push_subscriptions
      (user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `,
  ).run(userId, endpoint, p256dh, auth, userAgent || null);
  return { ok: true, sub: getByEndpoint(endpoint) };
}

// Touch last_seen_at if the endpoint exists; no-op otherwise. Used by the
// client on page load to reflect actual activity rather than the moment of
// last push delivery (which only fires when no client is visible — the
// opposite of "active"). Returns whether a row was updated.
export function heartbeatByEndpoint(userId: number, endpoint: string): boolean {
  const result = db
    .prepare(
      `
    UPDATE push_subscriptions
    SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ? AND endpoint = ?
  `,
    )
    .run(userId, endpoint);
  return result.changes > 0;
}

export function deleteByEndpoint(userId: number, endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(
    userId,
    endpoint,
  );
}

export function deleteById(id: number, userId: number): void {
  db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId);
}

export function touchSubscription(id: number): void {
  // strftime with Z suffix so the value parses back as UTC on the client.
  // SQLite's bare datetime('now') returns 'YYYY-MM-DD HH:MM:SS' with no TZ
  // marker, which Date.parse() then treats as local time. A successful
  // delivery also clears the failure streak (#441).
  db.prepare(
    "UPDATE push_subscriptions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), fail_count = 0 WHERE id = ?",
  ).run(id);
}

// Record a non-permanent delivery failure and return the new consecutive-failure
// count (#441). The caller disables the subscription once this crosses a
// threshold so a chronically-broken endpoint stops erroring on every push; any
// success (touchSubscription) or re-subscribe (upsertSubscription) resets it.
export function recordFailure(id: number): number {
  db.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?').run(id);
  const row = db.prepare('SELECT fail_count FROM push_subscriptions WHERE id = ?').get(id) as
    | { fail_count: number }
    | undefined;
  return row?.fail_count ?? 0;
}

// Stop delivering to a subscription without deleting it, so the row (and its
// history) survives and a later re-subscribe re-enables it. Used when an
// endpoint has failed too many times in a row (#441).
export function disableSubscription(id: number): void {
  db.prepare('UPDATE push_subscriptions SET enabled = 0 WHERE id = ?').run(id);
}

// app_meta single-key store for VAPID config
export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.prepare(
    `
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `,
  ).run(key, value);
}
