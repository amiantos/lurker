// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import webpush from 'web-push';
import type { PushSubscription } from '../db/pushSubscriptions.js';
import { prepareNotification, type PushPayload } from './notificationContent.js';
import { senderFor, warnUnconfiguredOnce } from './push/index.js';
import { relayAllows } from './push/relay.js';
import { resolveVapidSubject, type VapidSubject } from './push/vapidSubject.js';
import { recordPushLog, type PushLogSubject } from '../db/pushLog.js';
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

const VAPID = resolveVapidSubject();

/** For the admin pane: whether Apple's push service will take our contact. */
export function vapidSubjectStatus() {
  return VAPID;
}

// Called at boot (server.ts, beside assertPushCredentials) rather than at
// import, so an unattended restart says it but every test file doesn't.
export function warnVapidSubject(v: VapidSubject = VAPID): void {
  if (v.ignored !== null) {
    console.warn(
      `[push] ignoring VAPID_SUBJECT "${v.ignored}": it needs to be mailto: an address ` +
        `on a public domain, or an https:// URL. Using "${v.subject}".`,
    );
  }
  if (!v.appleAccepts) {
    console.warn(
      `[push] VAPID subject "${v.subject}" has no public domain, so Safari and ` +
        'home-screen web apps on iPhone will refuse Web Push. Set VAPID_SUBJECT to ' +
        'mailto:you@yourdomain or https://yourdomain.',
    );
  }
}

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
  webpush.setVapidDetails(VAPID.subject, publicKey, privateKey);
  vapidConfigured = true;
}

export function getPublicKey(): string | null {
  ensureVapid();
  return publicKey;
}

/** The server's VAPID identity, for signing a request of our own — the relay's
 *  status check (push/relayStatus.ts). */
export function vapidCredentials(): { subject: string; publicKey: string; privateKey: string } {
  ensureVapid();
  return { subject: VAPID.subject, publicKey: publicKey!, privateKey: privateKey! };
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

/** The push log's view of a payload (#1272): what it's about, never its text. */
function logSubject(message: PushPayload): PushLogSubject {
  return {
    kind: message.kind,
    networkId: message.networkId,
    networkName: message.networkName,
    target: message.target,
    nick: message.nick ?? null,
    messageId: message.messageId ?? null,
  };
}

/** The HTTP status a sender's failure carried, when it carried one. */
function failureStatus(err: unknown): number | null {
  // web-push says statusCode; the APNs and FCM errors say status.
  const e = err as { statusCode?: unknown; status?: unknown } | null;
  const status = e?.statusCode ?? e?.status;
  return typeof status === 'number' ? status : null;
}

export async function deliver(
  userId: number,
  message: PushPayload,
): Promise<{ sent: number; dropped: number }> {
  // VAPID is Web Push's business, but it's cheap and idempotent, and hoisting it
  // here keeps the "which transports does this user have?" question out of it.
  ensureVapid();
  const subs = listEnabledForUser(userId);
  if (!subs.length) return { sent: 0, dropped: 0 };
  // Every exit below writes to the push log (#1272): the suppressed ones by
  // reason, the attempted ones per device with the service's answer. Logging
  // must never fail a push, so each write is best-effort.
  const subject = logSubject(message);
  const log = (entry: Parameters<typeof recordPushLog>[1]) => {
    try {
      recordPushLog(userId, entry);
    } catch (err) {
      console.warn('[push] log write failed:', (err as Error)?.message || err);
    }
  };

  // Clamped, composed and fitted once, here, so no transport can be handed a
  // message over its size cap. Composition is transport-neutral and identical
  // for every device; each sender renders it its own way — JSON for a service
  // worker, an `aps` dict for APNs, a string data map for FCM.
  const { payload, content, fits } = prepareNotification(message);
  if (!fits) {
    // Even cut down it's over every transport's 4 KB (see fitPushBody): sending
    // would only earn a refusal, which counts against the device. One lost
    // notification beats a disabled phone.
    console.warn(
      `[push] dropped a ${payload.kind} push for user ${userId}: over 4 KB even with ` +
        'its text cut (an extreme channel or nick name)',
    );
    log({ ...subject, outcome: 'suppressed', reason: 'oversize' });
    return { sent: 0, dropped: 0 };
  }

  // Skip transports with no credentials rather than attempting them. A
  // self-hosted server holds no APNs key and that's normal operation; without
  // this, every push to a native device would throw and count as a failure,
  // eventually disabling the device for a reason that isn't the device's fault.
  //
  // A relay endpoint while the admin has the relay off is dropped, not sent to.
  // Registration refuses those and turning the relay off deletes them, but this
  // is where the opt-in has to hold: nothing reaches the relay without it.
  const deliverable = subs.filter((sub) => {
    if (sub.transport === 'webpush' && !relayAllows(sub.endpoint)) {
      deleteById(sub.id, sub.user_id);
      log({
        ...subject,
        outcome: 'suppressed',
        reason: 'relay_off',
        transport: sub.transport,
        device: describeSub(sub),
      });
      return false;
    }
    const sender = senderFor(sub.transport);
    if (sender.isConfigured()) return true;
    warnUnconfiguredOnce(sender);
    log({
      ...subject,
      outcome: 'suppressed',
      reason: 'unconfigured',
      transport: sub.transport,
      device: describeSub(sub),
    });
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
      log({
        ...subject,
        outcome: 'sent',
        transport: sub.transport,
        device: describeSub(sub),
        status: r.value ?? null,
      });
      return;
    }
    dropped += 1;
    const sender = senderFor(sub.transport);
    const verdict = sender.classify(r.reason);
    log({
      ...subject,
      outcome: 'failed',
      reason: `${verdict}: ${sender.describe(r.reason)}`.slice(0, 500),
      transport: sub.transport,
      device: describeSub(sub),
      status: failureStatus(r.reason),
    });
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
