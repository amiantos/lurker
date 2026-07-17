// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// FCM (#490 phase 3).
//
// The mirror image of apnsSender, and the reason the seam is shaped the way it
// is. Same job, but: HTTP/1.1 so plain fetch works, and OAuth2 rather than a
// self-signed bearer — we sign an RS256 assertion with the service-account key
// and trade it with Google for an access token, instead of signing the bearer
// APNs accepts directly.
//
// ⚠ Android is paused (see APP_1.0_SCOPE.md), so nothing here has ever pushed to
// a real device. Auth, token minting/refresh, request shape and error mapping are
// all exercised — FCM answers a bogus token with a well-formed UNREGISTERED — but
// "a phone rendered this correctly" is NOT proven and won't be until Android
// unpauses. Built now anyway because designing the seam against one provider is a
// guess about where the variation lives; against two it's a measurement.

import type { PushSubscription } from '../../db/pushSubscriptions.js';
import type { NotificationContent, PushPayload } from '../notificationContent.js';
import type { FailureClass, PushSender } from './types.js';
import { fcmCredentials } from './credentials.js';
import { signJwt, TokenCache } from './jwt.js';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const ASSERTION_LIFETIME_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 10_000;

/** An FCM rejection, carrying the bits classify() and describe() need. */
export class FcmError extends Error {
  constructor(
    readonly status: number | null,
    /** Google's machine-readable error status, e.g. 'UNREGISTERED'. */
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'FcmError';
  }
}

const accessToken = new TokenCache(async () => {
  const creds = fcmCredentials();
  if (!creds) throw new Error('FCM is not configured');
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    'RS256',
    {},
    {
      iss: creds.clientEmail,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: now,
      exp: now + ASSERTION_LIFETIME_SECONDS,
    },
    creds.privateKeyPem,
  );
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new FcmError(
      res.status,
      'OAUTH_FAILED',
      `FCM token exchange failed: ${text.slice(0, 300)}`,
    );
  }
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new FcmError(res.status, 'OAUTH_FAILED', 'FCM token exchange returned no access_token');
  }
  return { token: json.access_token, lifetimeSeconds: json.expires_in ?? 3600 };
});

/** Test-only: drop the cached access token. */
export function resetFcmState(): void {
  accessToken.reset();
}

/**
 * The FCM v1 message body, as pure data. Split out from send() for the same
 * reason as buildApnsRequest — and more urgently here, since Android is paused
 * and this is the only check on the shape until it isn't.
 */
export function buildFcmMessage(
  sub: PushSubscription,
  payload: PushPayload,
  content: NotificationContent,
): Record<string, unknown> {
  return {
    message: {
      token: sub.endpoint,
      notification: { title: content.title, body: content.body },
      android: {
        priority: 'HIGH',
        // Same role as the Notification API's tag / APNs' thread-id: a later
        // notification for a buffer replaces the earlier one.
        collapse_key: content.tag,
        notification: { tag: content.tag },
      },
      // FCM requires every data value to be a string — a number here is rejected
      // outright, so this is not the place to be clever about types.
      data: {
        kind: payload.kind,
        networkId: String(payload.networkId),
        target: payload.target,
        ...(payload.messageId != null ? { messageId: String(payload.messageId) } : {}),
        ...(typeof payload.badge === 'number' ? { badge: String(payload.badge) } : {}),
      },
    },
  };
}

export const fcmSender: PushSender = {
  transport: 'fcm',

  isConfigured(): boolean {
    return fcmCredentials() !== null;
  },

  configHint(): string {
    return 'set LURKER_FCM_SERVICE_ACCOUNT to a Google service-account JSON';
  },

  async send(
    sub: PushSubscription,
    payload: PushPayload,
    content: NotificationContent,
  ): Promise<void> {
    const creds = fcmCredentials();
    if (!creds) throw new Error('FCM is not configured');
    const token = await accessToken.get();

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildFcmMessage(sub, payload, content)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (res.ok) return;
    const text = await res.text();
    let reason: string | null = null;
    try {
      reason = (JSON.parse(text) as { error?: { status?: string } }).error?.status ?? null;
    } catch {
      /* a non-JSON body just means no reason to read */
    }
    throw new FcmError(
      res.status,
      reason,
      `FCM rejected: ${res.status} ${reason ?? text.slice(0, 300)}`,
    );
  },

  classify(err: unknown): FailureClass {
    const e = err as Partial<FcmError>;
    const reason = e?.reason ?? null;
    const status = e?.status ?? null;

    // The app was uninstalled or the token was replaced.
    if (reason === 'UNREGISTERED' || reason === 'NOT_FOUND') return 'permanent';
    // A token that isn't a token — or, notably, one minted for a DIFFERENT
    // Firebase project (MismatchSenderId). Retrying never fixes either.
    if (reason === 'INVALID_ARGUMENT' || reason === 'SENDER_ID_MISMATCH') return 'permanent';
    if (status === 404) return 'permanent';

    // OUR service account is broken, not this device — same reasoning as APNs'
    // 403: it fails identically for every device, so a strike would disable the
    // whole fleet for an operator's misconfiguration.
    if (status === 401 || status === 403 || reason === 'OAUTH_FAILED') {
      accessToken.reset();
      return 'transient';
    }

    // Google throttling us (QUOTA_EXCEEDED/429), or FCM being down.
    if (status == null || status === 429 || status >= 500) return 'transient';
    return 'strike';
  },

  describe(err: unknown): string {
    const e = err as Partial<FcmError>;
    return `status=${e?.status ?? '?'} reason=${e?.reason ?? '?'} message=${e?.message || String(err)}`;
  },
};
