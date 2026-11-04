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
// ⚠ Nothing here has pushed to a real device yet (#588). Auth, token
// minting/refresh, request shape and error mapping are all exercised — FCM
// answers a bogus token with a well-formed UNREGISTERED — but "a phone rendered
// this correctly" is NOT proven until the Android app's receiver ships
// (lurker-android#16). Built ahead of the app because designing the seam against
// one provider is a guess about where the variation lives; against two it's a
// measurement.

import type { PushSubscription } from '../../db/pushSubscriptions.js';
import {
  PUSH_TTL_SECONDS,
  pushBody,
  type NotificationContent,
  type PushPayload,
} from '../notificationContent.js';
import type { FailureClass, PushSender } from './types.js';
import { configuredFcm } from './credentials.js';
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
    /** Whether Google named the registration token as the bad argument, rather
     *  than something we built (an oversized message, a reserved data key). */
    readonly tokenRejected = false,
  ) {
    super(message);
    this.name = 'FcmError';
  }
}

interface FcmErrorBody {
  error?: {
    status?: string;
    message?: string;
    details?: { '@type'?: string; errorCode?: string; fieldViolations?: { field?: string }[] }[];
  };
}

// FCM's own code (UNREGISTERED, SENDER_ID_MISMATCH, …) rides in `details`, in an
// FcmError entry (firebase.google.com/docs/cloud-messaging/error-codes).
// `error.status` is only the generic gRPC status: a dead token reads NOT_FOUND
// there and a foreign-project token PERMISSION_DENIED, which on its own looks
// like our credentials failing.
function fcmErrorCode(body: FcmErrorBody): string | null {
  const entry = (body.error?.details ?? []).find((d) => d['@type']?.endsWith('.FcmError'));
  return entry?.errorCode ?? null;
}

// INVALID_ARGUMENT covers a bad token AND a bad message — over 4 KB, a reserved
// data key — and only the first is the device's fault. Google's documented
// answer to a bad token is "The registration token is not a valid FCM
// registration token"; a field violation on `message.token` is the structured
// form. Anything else is ours, and must never read as permanent: one payload bug
// would otherwise delete every Android device that received it.
function namesTheToken(body: FcmErrorBody): boolean {
  const error = body.error;
  if (!error) return false;
  const violations = (error.details ?? []).flatMap((d) => d.fieldViolations ?? []);
  if (violations.some((v) => v.field === 'message.token')) return true;
  return /registration token/i.test(error.message ?? '');
}

const accessToken = new TokenCache(async () => {
  const creds = configuredFcm();
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

// Google rejecting OUR service account rather than the device. Shared by
// classify() and onFailure() so the verdict and the reaction agree.
function isCredentialRejection(status: number | null, reason: string | null): boolean {
  if (reason === 'SENDER_ID_MISMATCH') return false; // a 403 about the device, not us

  return (
    status === 401 ||
    status === 403 ||
    reason === 'OAUTH_FAILED' ||
    reason === 'THIRD_PARTY_AUTH_ERROR'
  );
}

/**
 * The FCM v1 message body, as pure data. Split out from send() for the same
 * reason as buildApnsRequest — and more urgently here, since this is the only
 * check on the shape until a real device has received one (#588).
 *
 * Data-only: there is no `notification` block. With one, Android draws the
 * notification itself whenever the app is in the background and never calls the
 * app's FirebaseMessagingService, so the app could not pick a channel per kind,
 * group by buffer, or replace an earlier notification by tag. It also could not
 * render a push relayed for a self-hosted server (#1045), which arrives
 * encrypted and has to be decrypted by the app before anything can be shown.
 * One renderer serves both because the data map below carries the same keys as
 * the Web Push body.
 *
 * No `collapse_key`: FCM keeps at most four collapse keys per device while it is
 * offline and drops the rest with no rule for which, so keying per buffer would
 * lose whole buffers' notifications for a phone with more than four of them
 * pending. Firebase's guidance for chat is non-collapsible; replacing an earlier
 * notification for the same buffer is the app's job, using `tag`.
 */
export function buildFcmMessage(
  sub: PushSubscription,
  payload: PushPayload,
  content: NotificationContent,
): Record<string, unknown> {
  // FCM requires every data value to be a string — a number is rejected with a
  // 400 INVALID_ARGUMENT, which classify() reads as permanent and DELETES the
  // device over. Null and undefined are left out rather than stringified into
  // "null"/"undefined", which a client would parse into nonsense; an absent key
  // reads the same as the Web Push body's null.
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(pushBody(payload, content))) {
    if (value != null) data[key] = String(value);
  }
  return {
    message: {
      token: sub.endpoint,
      // HIGH so a dozing phone wakes to run the app's handler now. Android
      // deprioritizes an app whose high-priority messages don't end in a visible
      // notification, so the handler must always post one.
      android: { priority: 'HIGH', ttl: `${PUSH_TTL_SECONDS}s` },
      data,
    },
  };
}

export const fcmSender: PushSender = {
  transport: 'fcm',

  isConfigured(): boolean {
    return configuredFcm() !== null;
  },

  configHint(): string {
    return 'set LURKER_FCM_SERVICE_ACCOUNT to a Google service-account JSON';
  },

  async send(
    sub: PushSubscription,
    payload: PushPayload,
    content: NotificationContent,
  ): Promise<number> {
    const creds = configuredFcm();
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
    if (res.ok) return res.status;
    const text = await res.text();
    let reason: string | null = null;
    let tokenRejected = false;
    try {
      const body = JSON.parse(text) as FcmErrorBody;
      reason = fcmErrorCode(body) ?? body.error?.status ?? null;
      tokenRejected = namesTheToken(body);
    } catch {
      /* a non-JSON body just means no reason to read */
    }
    throw new FcmError(
      res.status,
      reason,
      `FCM rejected: ${res.status} ${reason ?? text.slice(0, 300)}`,
      tokenRejected,
    );
  },

  classify(err: unknown): FailureClass {
    const e = err as Partial<FcmError>;
    const reason = e?.reason ?? null;
    const status = e?.status ?? null;

    // The app was uninstalled or the token was replaced.
    if (reason === 'UNREGISTERED') return 'permanent';
    // A token minted for a DIFFERENT Firebase project (MismatchSenderId).
    // Retrying never fixes it.
    if (reason === 'SENDER_ID_MISMATCH') return 'permanent';
    // A token that isn't a token is permanent; any other INVALID_ARGUMENT is a
    // message WE built wrong, so it strikes rather than deletes — see
    // namesTheToken.
    if (reason === 'INVALID_ARGUMENT') return e?.tokenRejected ? 'permanent' : 'strike';
    // A 404 that isn't UNREGISTERED is the URL — our project id — not the device.
    // Reading it as permanent would delete every Android device on one typo.
    if (status === 404) return 'transient';

    // OUR service account is broken, not this device — same reasoning as APNs'
    // 403: it fails identically for every device, so a strike would disable the
    // whole fleet for an operator's misconfiguration.
    if (isCredentialRejection(status, reason)) return 'transient';

    // Google throttling us (QUOTA_EXCEEDED/429), or FCM being down.
    if (status == null || status === 429 || status >= 500) return 'transient';
    return 'strike';
  },

  onFailure(err: unknown): void {
    // Drop the access token so the next push re-runs the OAuth2 exchange rather
    // than replaying one Google has already rejected.
    const e = err as Partial<FcmError>;
    if (isCredentialRejection(e?.status ?? null, e?.reason ?? null)) accessToken.reset();
  },

  describe(err: unknown): string {
    const e = err as Partial<FcmError>;
    return `status=${e?.status ?? '?'} reason=${e?.reason ?? '?'} message=${e?.message || String(err)}`;
  },
};
