// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/**
 * How a subscription is delivered to (#490).
 *
 * `webpush` is a push-service URL plus an ECDH keypair (RFC 8291). `apns` and
 * `fcm` are opaque per-install device tokens with no keypair at all — which is
 * why the crypto columns are nullable and why this discriminator exists rather
 * than the code sniffing at the endpoint's shape.
 */
export type PushTransport = 'webpush' | 'apns' | 'fcm';

export const NATIVE_TRANSPORTS: ReadonlySet<PushTransport> = new Set<PushTransport>([
  'apns',
  'fcm',
]);

export function isPushTransport(value: unknown): value is PushTransport {
  return value === 'webpush' || value === 'apns' || value === 'fcm';
}

/** A row from the `push_subscriptions` table. */
export interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  transport: string;
  p256dh: string | null;
  auth: string | null;
  user_agent: string | null;
  enabled: number;
  created_at: string;
  last_seen_at: string;
  fail_count: number;
}

interface PushSubscriptionBase {
  id: number;
  user_id: number;
  endpoint: string;
  user_agent: string | null;
  enabled: boolean;
  created_at: string;
  last_seen_at: string;
  fail_count: number;
}

/**
 * Projected push subscription, discriminated on transport so the credential
 * shape follows from it. A `webpush` sub always has its keys and a native one
 * never does — the union is what lets deliver() narrow to a transport and reach
 * for `p256dh` without a non-null assertion, and what makes "native sub with
 * Web Push keys" unrepresentable rather than merely unlikely.
 */
export type PushSubscription =
  | (PushSubscriptionBase & { transport: 'webpush'; p256dh: string; auth: string })
  | (PushSubscriptionBase & { transport: 'apns' | 'fcm'; p256dh: null; auth: null });

function rowToSub(row: PushSubscriptionRow | undefined): PushSubscription | null {
  if (!row) return null;
  const base: PushSubscriptionBase = {
    id: row.id,
    user_id: row.user_id,
    endpoint: row.endpoint,
    user_agent: row.user_agent,
    enabled: !!row.enabled,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    fail_count: row.fail_count ?? 0,
  };
  if (!isPushTransport(row.transport)) {
    // A transport this build doesn't know — e.g. a row written by a NEWER server
    // after a downgrade. Skipping it is the safe read: we cannot deliver to a
    // transport we can't speak, and guessing would mean handing an opaque token
    // to the Web Push sender. The row survives for the newer build to use again.
    console.warn(`[push] ignoring subscription ${row.id}: unknown transport ${row.transport}`);
    return null;
  }
  if (row.transport === 'webpush') {
    if (row.p256dh == null || row.auth == null) {
      // Web Push without a keypair can't be encrypted, so it can't be sent. Only
      // reachable via direct DB surgery, but skip rather than crash the fan-out
      // for every other device the user owns.
      console.warn(`[push] ignoring webpush subscription ${row.id}: missing keys`);
      return null;
    }
    return { ...base, transport: 'webpush', p256dh: row.p256dh, auth: row.auth };
  }
  return { ...base, transport: row.transport, p256dh: null, auth: null };
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

/**
 * What to register. The union means a Web Push subscription cannot be filed
 * without its keypair, and a native one cannot smuggle keys it doesn't have.
 */
export type SubscriptionInput =
  | {
      transport: 'webpush';
      endpoint: string;
      p256dh: string;
      auth: string;
      userAgent?: string | null;
    }
  | { transport: 'apns' | 'fcm'; endpoint: string; userAgent?: string | null };

// Ownership on a cross-user collision is decided by transport, because the two
// cases mean opposite things (#490):
//
// - webpush: endpoint URLs persist per browser/PushManager, so when two users
//   log into the same browser, subscribe() hands back the SAME endpoint for
//   both — concurrently. A blind rebind would silently steal the other user's
//   notifications, so refuse; the previous owner disables push first.
//
// - apns/fcm: the token identifies an app INSTALL, and an install has exactly
//   one signed-in user at a time. The same token coming back under a different
//   user means the phone changed hands (sign out → sign in), so rebind — that
//   is the truth, not a collision. Refusing here would be an outright bug: a
//   sign-out that failed to deregister (crash, offline, force-quit) would leave
//   the token owned by the old account and the new user permanently unpushable,
//   with no UI anywhere to release it.
//
// Returns { ok, sub } on success or { ok: false, error } on a refused collision.
export function upsertSubscription(
  userId: number,
  input: SubscriptionInput,
): { ok: true; sub: PushSubscription | null } | { ok: false; error: string } {
  const { transport, endpoint, userAgent } = input;
  const p256dh = transport === 'webpush' ? input.p256dh : null;
  const auth = transport === 'webpush' ? input.auth : null;

  const existing = getByEndpoint(endpoint);
  if (existing && existing.user_id !== userId && transport === 'webpush') {
    return { ok: false, error: 'endpoint_owned_by_other_user' };
  }
  if (existing) {
    // user_id is reassigned on a native rebind; for webpush it's a no-op write of
    // the value it already held, since a cross-user webpush row returned above.
    db.prepare(
      `
      UPDATE push_subscriptions
      SET user_id = ?, transport = ?, p256dh = ?, auth = ?,
          user_agent = COALESCE(?, user_agent),
          enabled = 1, fail_count = 0,
          last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE endpoint = ?
    `,
    ).run(userId, transport, p256dh, auth, userAgent || null, endpoint);
    return { ok: true, sub: getByEndpoint(endpoint) };
  }
  db.prepare(
    `
    INSERT INTO push_subscriptions
      (user_id, endpoint, transport, p256dh, auth, user_agent, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `,
  ).run(userId, endpoint, transport, p256dh, auth, userAgent || null);
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
