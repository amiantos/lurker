// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Web Push over the seam (#490 phase 3).
//
// This is the pre-existing behavior moved, not rewritten — the classify() rules
// below are the exact status checks deliver() used to make inline, and their
// reasoning is preserved with them. It's also the transport the other two are
// measured against: it went first through the seam precisely to check the seam
// could hold something real.

import webpush from 'web-push';
import type { PushSubscription } from '../../db/pushSubscriptions.js';
import type { NotificationContent, PushPayload } from '../notificationContent.js';
import type { FailureClass, PushSender } from './types.js';

interface WebPushErrorish {
  statusCode?: number;
  message?: string;
  body?: string;
}

export const webpushSender: PushSender = {
  transport: 'webpush',

  // VAPID keys are generated on demand and stored in app_meta, so Web Push is
  // always configured — unlike the native transports, it needs nothing from the
  // operator.
  isConfigured: () => true,
  configHint: () => '',

  async send(
    sub: PushSubscription,
    payload: PushPayload,
    content: NotificationContent,
  ): Promise<void> {
    if (sub.transport !== 'webpush') {
      // Unreachable: pushService dispatches by sub.transport. Narrows the union
      // so p256dh/auth are known present, and states the invariant out loud.
      throw new Error(`webpushSender received a ${sub.transport} subscription`);
    }
    // Composed fields ride ALONGSIDE the semantic ones so a service worker
    // cached before #490 phase 2 can still compose locally. See sw.js.
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ ...payload, ...content }),
    );
  },

  classify(err: unknown): FailureClass {
    const status = (err as WebPushErrorish)?.statusCode;
    // The push service says this endpoint is gone for good.
    if (status === 404 || status === 410) return 'permanent';
    // Rate limits (429), server errors (5xx), and transport-level errors with no
    // statusCode (DNS/connect blips, timeouts) are the network or the service
    // having a bad moment — not a dead subscription. Otherwise a short outage
    // during a burst of notifications could disable a healthy endpoint.
    if (status == null || status === 429 || status >= 500) return 'transient';
    // A concrete 4xx (auth rejects, malformed requests, gone-but-not-404/410).
    return 'strike';
  },

  describe(err: unknown): string {
    const e = err as WebPushErrorish;
    const body = typeof e?.body === 'string' ? e.body.slice(0, 500) : '';
    return `status=${e?.statusCode ?? '?'} message=${e?.message || String(err)} body=${body}`;
  },
};
