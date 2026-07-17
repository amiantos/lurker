// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// APNs (#490 phase 3).
//
// The one place the providers genuinely diverge in plumbing rather than payload:
// **APNs requires HTTP/2**, and Node's fetch/undici does not speak it. So this
// talks node:http2 directly rather than going through the fetch-shaped path FCM
// uses. That asymmetry is the reason APNs and FCM were built together — an
// abstraction designed around FCM alone would have baked in fetch and had to be
// unpicked here.
//
// No dependency: the provider bearer is an ES256 JWT we sign ourselves (see
// jwt.ts), and http2 is stdlib. `apns2`/`node-apn` would mostly be buying a
// connection pool, which the session cache below covers for our fan-out sizes.

import http2 from 'node:http2';
import crypto from 'node:crypto';
import type { PushSubscription } from '../../db/pushSubscriptions.js';
import type { NotificationContent, PushPayload } from '../notificationContent.js';
import type { FailureClass, PushSender } from './types.js';
import { apnsCredentials, type ApnsCredentials } from './credentials.js';
import { signJwt, TokenCache } from './jwt.js';

const PROD_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
const REQUEST_TIMEOUT_MS = 10_000;

/** An APNs rejection, carrying the bits classify() and describe() need. */
export class ApnsError extends Error {
  constructor(
    readonly status: number | null,
    /** Apple's machine-readable `reason`, e.g. 'Unregistered', 'BadDeviceToken'. */
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApnsError';
  }
}

// Apple caps provider-token refresh at once per 20 minutes (more earns
// TooManyProviderTokenUpdates) and expires them at 60. An hour lifetime with the
// default 5-minute skew lands comfortably inside both.
const TOKEN_LIFETIME_SECONDS = 3600;

const providerToken = new TokenCache(async () => {
  const creds = apnsCredentials();
  if (!creds) throw new Error('APNs is not configured');
  const token = signJwt(
    'ES256',
    { kid: creds.keyId },
    { iss: creds.teamId, iat: Math.floor(Date.now() / 1000) },
    creds.keyPem,
  );
  return { token, lifetimeSeconds: TOKEN_LIFETIME_SECONDS };
});

// One HTTP/2 session, reused. A push fans out to every device at once and APNs
// multiplexes them over a single connection — opening one per notification would
// pay a TLS handshake per device and is what Apple explicitly asks providers not
// to do. Lazily (re)created: a session that errored or was closed by Apple is
// discarded and the next send opens a fresh one.
let session: http2.ClientHttp2Session | null = null;

function getSession(host: string): http2.ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session;
  const next = http2.connect(host);
  // Without a handler, an async session error (Apple closing an idle connection,
  // a network drop) is an unhandled 'error' event and takes the process down.
  next.on('error', () => {
    if (session === next) session = null;
  });
  next.on('close', () => {
    if (session === next) session = null;
  });
  next.unref();
  session = next;
  return next;
}

/** Test-only: drop the cached session and provider token. */
export function resetApnsState(): void {
  if (session && !session.destroyed) session.destroy();
  session = null;
  providerToken.reset();
}

/**
 * The APNs wire format, as pure data.
 *
 * Split out from send() so it's testable without a gateway: the `aps` dict is
 * what decides whether a real phone renders the notification correctly, and it's
 * the part we cannot check against Apple until there's a signed build. Getting it
 * checkable here is the difference between "unverified" and "unverifiable".
 */
export function buildApnsRequest(
  sub: PushSubscription,
  payload: PushPayload,
  content: NotificationContent,
  creds: ApnsCredentials,
  jwt: string,
): { headers: Record<string, string>; body: string } {
  return {
    headers: {
      ':method': 'POST',
      ':path': `/3/device/${sub.endpoint}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': creds.bundleId,
      'apns-push-type': 'alert',
      // 10 is "deliver immediately"; a chat notification is the case this is
      // for. (5 asks APNs to conserve power, which delays it.)
      'apns-priority': '10',
      // Collapses a buffer's notifications on the device — the same role `tag`
      // plays for the Notification API. Distinct from thread-id, which only
      // GROUPS them in the notification centre.
      'apns-collapse-id': collapseId(content.tag),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      aps: {
        alert: { title: content.title, body: content.body },
        // Only stamped when the payload carries one: a friend-online push
        // deliberately omits it (#451), and sending 0 there would CLEAR the
        // user's badge rather than leave it alone.
        ...(typeof payload.badge === 'number' ? { badge: payload.badge } : {}),
        sound: 'default',
        'thread-id': content.tag,
      },
      // Custom keys live beside `aps`, and are what tap-to-open reads to know
      // which buffer to jump to.
      networkId: payload.networkId,
      target: payload.target,
      messageId: payload.messageId,
      kind: payload.kind,
    }),
  };
}

// APNs rejects an apns-collapse-id over 64 BYTES with BadCollapseId. A channel
// name is UTF-8 and can carry multibyte characters, so measure bytes, not
// characters, and hash anything too long rather than truncating — a truncated id
// could collide two buffers whose names share a prefix, silently replacing one
// buffer's notification with another's.
function collapseId(tag: string): string {
  const bytes = Buffer.from(tag, 'utf8');
  if (bytes.length <= 64) return tag;
  return crypto.createHash('sha256').update(bytes).digest('base64url').slice(0, 43);
}

export const apnsSender: PushSender = {
  transport: 'apns',

  isConfigured(): boolean {
    return apnsCredentials() !== null;
  },

  configHint(): string {
    return 'set LURKER_APNS_KEY, LURKER_APNS_KEY_ID, LURKER_APNS_TEAM_ID and LURKER_APNS_BUNDLE_ID';
  },

  async send(
    sub: PushSubscription,
    payload: PushPayload,
    content: NotificationContent,
  ): Promise<void> {
    const creds = apnsCredentials();
    if (!creds) throw new Error('APNs is not configured');
    const jwt = await providerToken.get();
    const { headers, body } = buildApnsRequest(sub, payload, content, creds, jwt);

    const client = getSession(creds.sandbox ? SANDBOX_HOST : PROD_HOST);
    await new Promise<void>((resolve, reject) => {
      const req = client.request(headers);
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        // No status: classify() reads that as transient, which a timeout is.
        reject(new ApnsError(null, null, 'APNs request timed out'));
      });

      let status: number | null = null;
      let responseBody = '';
      req.on('response', (headers) => {
        status = Number(headers[':status']) || null;
      });
      req.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString();
      });
      req.on('error', (err) => reject(new ApnsError(null, null, err.message)));
      req.on('end', () => {
        if (status === 200) {
          resolve();
          return;
        }
        // Apple returns {"reason":"Unregistered"} — the reason, not the status,
        // is what distinguishes a dead device from a bad key.
        let reason: string | null = null;
        try {
          reason = (JSON.parse(responseBody) as { reason?: string }).reason ?? null;
        } catch {
          /* a non-JSON body just means no reason to read */
        }
        reject(new ApnsError(status, reason, `APNs rejected: ${status} ${reason ?? responseBody}`));
      });
      req.end(body);
    });
  },

  classify(err: unknown): FailureClass {
    const e = err as Partial<ApnsError>;
    const reason = e?.reason ?? null;
    const status = e?.status ?? null;

    // The device is gone: uninstalled, or the token was never ours to use.
    // BadDeviceToken also covers the classic environment mix-up — a sandbox
    // token sent to production — which no amount of retrying fixes.
    if (reason === 'Unregistered' || reason === 'BadDeviceToken') return 'permanent';
    if (reason === 'DeviceTokenNotForTopic') return 'permanent';
    if (status === 410) return 'permanent';

    // OUR credentials are broken, not this device. Every device fails
    // identically, so a strike would march the user's whole fleet to disabled
    // after five pushes and force each to re-register once the key was fixed.
    // Transient keeps them alive; the operator fixes the key and delivery
    // resumes on its own.
    if (
      reason === 'InvalidProviderToken' ||
      reason === 'ExpiredProviderToken' ||
      reason === 'MissingProviderToken' ||
      status === 403
    ) {
      // The cached token may simply have aged out against a clock skew; drop it
      // so the next attempt mints a fresh one rather than replaying a dead one.
      providerToken.reset();
      return 'transient';
    }

    // Apple throttling us, Apple being down, or no response at all.
    if (status == null || status === 429 || status >= 500) return 'transient';
    return 'strike';
  },

  describe(err: unknown): string {
    const e = err as Partial<ApnsError>;
    return `status=${e?.status ?? '?'} reason=${e?.reason ?? '?'} message=${e?.message || String(err)}`;
  },
};
