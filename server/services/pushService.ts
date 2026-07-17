// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import webpush from 'web-push';
import type { PushSubscription } from '../db/pushSubscriptions.js';
import { composeNotification, type PushPayload } from './notificationContent.js';
import { senderFor, warnUnconfiguredOnce } from './push/index.js';
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

// Identify a subscription in a log line without printing the endpoint whole. For
// Web Push the host is the useful part — it says WHICH push service is failing.
// A device token has no structure to extract, and is enough of a credential that
// a log file is the wrong place for it, so it gets a prefix.
function describeSub(sub: PushSubscription): string {
  if (sub.transport === 'webpush') {
    try {
      return new URL(sub.endpoint).host;
    } catch {
      return 'invalid-endpoint';
    }
  }
  return `${sub.endpoint.slice(0, 8)}…`;
}

export async function deliver(
  userId: number,
  payload: PushPayload,
): Promise<{ sent: number; dropped: number }> {
  // VAPID is Web Push's business, but it's cheap and idempotent, and hoisting it
  // here keeps the "which transports does this user have?" question out of it.
  ensureVapid();
  const subs = listEnabledForUser(userId);
  if (!subs.length) return { sent: 0, dropped: 0 };

  // Composition is transport-neutral and identical for every device, so it
  // happens once rather than per sub. Each sender renders it its own way — JSON
  // for a service worker, an `aps` dict for APNs, a `notification` for FCM.
  const content = composeNotification(payload);

  // Skip transports with no credentials rather than attempting them. A
  // self-hosted server holds no APNs key and that's normal operation; without
  // this, every push to a native device would throw and count as a failure,
  // eventually disabling the device for a reason that isn't the device's fault.
  const deliverable = subs.filter((sub) => {
    const sender = senderFor(sub.transport);
    if (sender.isConfigured()) return true;
    warnUnconfiguredOnce(sender);
    return false;
  });
  if (!deliverable.length) return { sent: 0, dropped: 0 };

  const results = await Promise.allSettled(
    deliverable.map((sub) => senderFor(sub.transport).send(sub, payload, content)),
  );
  let sent = 0;
  let dropped = 0;
  results.forEach((r, i) => {
    const sub = deliverable[i];
    if (r.status === 'fulfilled') {
      sent += 1;
      try {
        touchSubscription(sub.id);
      } catch (_) {
        /* ignore */
      }
      return;
    }
    dropped += 1;
    const sender = senderFor(sub.transport);
    const verdict = sender.classify(r.reason);
    // Anything the failure should CHANGE (invalidate a cached provider token,
    // drop a poisoned connection) happens here, not inside classify() — which is
    // a pure verdict and is called for logging as well as for control flow.
    sender.onFailure?.(r.reason, verdict);
    if (verdict === 'permanent') {
      // The provider says this device is gone for good — drop it.
      deleteById(sub.id, sub.user_id);
      return;
    }
    if (verdict === 'transient') {
      // The network or the provider is having a bad moment (or, for native, OUR
      // credentials are broken — which fails identically for every device and so
      // must never be charged to one). The subscription lives; we simply didn't
      // deliver this time. Silent by design: a rate limit or a 5xx during a
      // burst would otherwise write a line per device per push.
      return;
    }
    // A concrete rejection of THIS subscription. After enough consecutive
    // strikes, disable it so it stops erroring on every notification; a
    // re-subscribe re-enables it. Bounds console noise to a handful of lines per
    // broken endpoint instead of one on every push (#441).
    const failures = recordFailure(sub.id);
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      disableSubscription(sub.id);
      console.warn(
        `[push] disabled ${sub.transport} sub ${sub.id} (${describeSub(sub)}) after ` +
          `${failures} consecutive failures: ${sender.describe(r.reason)}`,
      );
      return;
    }
    console.warn(
      `[push] delivery failed for ${sub.transport} sub ${sub.id} (${describeSub(sub)}) ` +
        `[${failures}/${MAX_CONSECUTIVE_FAILURES}]: ${sender.describe(r.reason)}`,
    );
  });
  return { sent, dropped };
}
