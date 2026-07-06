// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import webpush from 'web-push';
import type { PushSubscription } from '../db/pushSubscriptions.js';
import {
  listEnabledForUser,
  hasEnabledForUser,
  deleteById,
  disableSubscription,
  recordFailure,
  touchSubscription,
  getMeta,
  setMeta,
} from '../db/pushSubscriptions.js';

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:lurker@localhost';

// A subscription that draws this many concrete 4xx rejections in a row — i.e.
// not an outright 404/410 (handled immediately) and not a transient 429/5xx or
// transport-level error (never counted) — is disabled so it stops erroring on
// every push (#441). Any success resets the streak.
const MAX_CONSECUTIVE_FAILURES = 5;

let vapidConfigured = false;
let publicKey: string | null = null;
let privateKey: string | null = null;

function ensureVapid(): void {
  if (vapidConfigured) return;
  publicKey = getMeta('vapid_public');
  privateKey = getMeta('vapid_private');
  if (!publicKey || !privateKey) {
    const generated = webpush.generateVAPIDKeys();
    publicKey = generated.publicKey;
    privateKey = generated.privateKey;
    setMeta('vapid_public', publicKey);
    setMeta('vapid_private', privateKey);
    console.log('[push] generated new VAPID keypair');
  }
  webpush.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);
  vapidConfigured = true;
}

export function getPublicKey(): string | null {
  ensureVapid();
  return publicKey;
}

// True if the user has at least one enabled push subscription. Lets callers
// skip building a push payload (e.g. computing the app-icon badge total) when
// deliver() would no-op on an empty subscription set anyway.
export function hasSubscriptions(userId: number): boolean {
  return hasEnabledForUser(userId);
}

export async function deliver(
  userId: number,
  payload: unknown,
): Promise<{ sent: number; dropped: number }> {
  ensureVapid();
  const subs: PushSubscription[] = listEnabledForUser(userId);
  if (!subs.length) return { sent: 0, dropped: 0 };
  const json = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        json,
      ),
    ),
  );
  let sent = 0;
  let dropped = 0;
  results.forEach((r, i) => {
    const sub = subs[i];
    if (r.status === 'fulfilled') {
      sent += 1;
      try {
        touchSubscription(sub.id);
      } catch (_) {
        /* ignore */
      }
      return;
    }
    const err = r.reason as webpush.WebPushError & { statusCode?: number };
    const status = err?.statusCode;
    if (status === 404 || status === 410) {
      // The push service says this endpoint is gone for good — drop it.
      deleteById(sub.id, sub.user_id);
      dropped += 1;
      return;
    }
    let host = '';
    try {
      host = new URL(sub.endpoint).host;
    } catch (_) {
      /* ignore */
    }
    // Don't count a failure toward the disable threshold unless the push
    // service actually rejected the subscription with an HTTP status. Rate
    // limits (429), server errors (5xx), and transport-level errors with no
    // statusCode (DNS/connect blips, timeouts) are the network or the service
    // having a bad moment — not a dead subscription. The subscription lives and
    // we simply didn't deliver this time; otherwise a short outage during a
    // burst of notifications could disable a perfectly healthy endpoint.
    if (status == null || status === 429 || status >= 500) {
      dropped += 1;
      return;
    }
    // A concrete 4xx rejection (auth rejects, malformed requests, gone-but-not-
    // 404/410) is a strike against this subscription. After enough consecutive
    // strikes we disable it so it stops erroring on every notification; a
    // re-subscribe re-enables it. This also bounds the console noise to a
    // handful of lines per broken endpoint instead of one on every push (#441).
    const failures = recordFailure(sub.id);
    const body = typeof err?.body === 'string' ? err.body.slice(0, 500) : '';
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      disableSubscription(sub.id);
      dropped += 1;
      console.warn(
        `[push] disabled sub ${sub.id} (${host}) after ${failures} consecutive failures: ` +
          `status=${status ?? '?'} message=${err?.message || String(err)} body=${body}`,
      );
      return;
    }
    dropped += 1;
    console.warn(
      `[push] delivery failed for sub ${sub.id} (${host}) [${failures}/${MAX_CONSECUTIVE_FAILURES}]: ` +
        `status=${status ?? '?'} message=${err?.message || String(err)} body=${body}`,
    );
  });
  return { sent, dropped };
}
