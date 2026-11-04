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
import {
  PUSH_TTL_SECONDS,
  type NotificationContent,
  type PushPayload,
} from '../notificationContent.js';
import type { FailureClass, PushSender } from './types.js';
import { configuredApns, type ApnsCredentials } from './credentials.js';
import { signJwt, TokenCache } from './jwt.js';

const PROD_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
const REQUEST_TIMEOUT_MS = 10_000;
// How long a new session gets to finish TCP + TLS + the HTTP/2 SETTINGS
// exchange. A session still connecting after this never will.
const CONNECT_TIMEOUT_MS = 10_000;

interface Gateway {
  prodHost: string;
  sandboxHost: string;
  connectOptions?: http2.SecureClientSessionOptions;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
}

const APPLE: Gateway = {
  prodHost: PROD_HOST,
  sandboxHost: SANDBOX_HOST,
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
};
let gateway: Gateway = APPLE;

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
  const creds = configuredApns();
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
let sessionHost: string | null = null;

/**
 * Test-only: point the sender at a local gateway (both hosts, TLS options,
 * timeouts), or with no argument back at Apple. Forgets the cached session.
 */
export function setApnsGatewayForTests(over: Partial<Gateway> = {}): void {
  gateway = { ...APPLE, ...over };
  if (session && !session.destroyed) session.destroy();
  session = null;
  sessionHost = null;
}

function getSession(host: string): http2.ClientHttp2Session {
  // The host is part of the cache key, not just an argument to the first call
  // that happens to open the session. Ignoring it would hand back a production
  // session for a sandbox request, where every token is invalid and classify()
  // reads BadDeviceToken as permanent — silently DELETING every real device
  // (review of #490).
  if (session && sessionHost === host && !session.closed && !session.destroyed) return session;
  // A different host is a config switch: nothing on the old session is wanted.
  // The same host but closed is DRAINING — Apple sent a graceful GOAWAY (Node
  // closes the session on one) — and the streams it already accepted still get
  // their real answers. Destroying it would turn each into a status-less
  // failure, and a dead device's 410 would never reach classify(). So it's only
  // dropped: it ends itself when they do. (Any other GOAWAY, Node destroys.)
  if (session && sessionHost !== host && !session.destroyed) session.destroy();
  const next = http2.connect(host, gateway.connectOptions);
  // Without a handler, an async session error (Apple closing an idle connection,
  // a network drop) is an unhandled 'error' event and takes the process down.
  next.on('error', () => {
    if (session === next) session = null;
  });
  next.on('close', () => {
    if (session === next) session = null;
  });
  // TCP up but TLS or SETTINGS never finishing: nothing on this session will
  // ever complete. Destroying it fails its pending pushes now rather than at
  // their timeouts, and is all it takes to stop it being reused — the check
  // above refuses a destroyed session, and 'close' forgets it.
  const deadline = setTimeout(() => {
    next.destroy(new Error(`APNs connect timed out after ${gateway.connectTimeoutMs} ms`));
  }, gateway.connectTimeoutMs);
  deadline.unref();
  next.once('connect', () => clearTimeout(deadline));
  next.once('close', () => clearTimeout(deadline));
  next.unref();
  session = next;
  sessionHost = host;
  return next;
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
      // Encoded even though the route already validates the token as hex: Node's
      // http2 neither validates nor encodes `:path`, so this is the last line
      // between an untrusted string and a request carrying our provider JWT. A
      // no-op for a real token, which is the point (review of #490).
      ':path': `/3/device/${encodeURIComponent(sub.endpoint)}`,
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
      // The same 48 hours as Web Push and FCM. Absent, APNs keeps a push for a
      // phone that's off and delivers it whenever it comes back.
      'apns-expiration': String(Math.floor(Date.now() / 1000) + PUSH_TTL_SECONDS),
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
      // which buffer to jump to. bufferId rides along for the same reason it
      // rides the web push payload (#744): a cold tap can address the buffer
      // by row id. Shipped iOS builds read networkId/target and ignore it.
      networkId: payload.networkId,
      target: payload.target,
      messageId: payload.messageId,
      bufferId: payload.bufferId,
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

// Apple rejecting OUR provider token rather than the device. Shared by classify()
// and onFailure() so the verdict and the reaction can never disagree about which
// failures are the credential's fault.
function isProviderTokenRejection(status: number | null, reason: string | null): boolean {
  return (
    reason === 'InvalidProviderToken' ||
    reason === 'ExpiredProviderToken' ||
    reason === 'MissingProviderToken' ||
    status === 403
  );
}

// Rejections of OUR configuration rather than of the device: a wrong
// LURKER_APNS_BUNDLE_ID reads TopicDisallowed or BadTopic for every device, and
// a strike per push would disable the whole fleet in five.
const CONFIG_REJECTIONS = new Set([
  'BadTopic',
  'MissingTopic',
  'TopicDisallowed',
  'BadCertificate',
  'BadCertificateEnvironment',
  'UnrelatedKeyIdInToken',
  'BadEnvironmentKeyInToken',
]);

export const apnsSender: PushSender = {
  transport: 'apns',

  isConfigured(): boolean {
    return configuredApns() !== null;
  },

  configHint(): string {
    return 'set LURKER_APNS_KEY, LURKER_APNS_KEY_ID, LURKER_APNS_TEAM_ID and LURKER_APNS_BUNDLE_ID';
  },

  async send(
    sub: PushSubscription,
    payload: PushPayload,
    content: NotificationContent,
  ): Promise<number> {
    const creds = configuredApns();
    if (!creds) throw new Error('APNs is not configured');
    const jwt = await providerToken.get();
    const { headers, body } = buildApnsRequest(sub, payload, content, creds, jwt);

    const client = getSession(creds.sandbox ? gateway.sandboxHost : gateway.prodHost);
    await new Promise<void>((resolve, reject) => {
      const req = client.request(headers);
      req.setTimeout(gateway.requestTimeoutMs, () => {
        // No status: classify() reads that as transient, which a timeout is.
        reject(new ApnsError(null, null, 'APNs request timed out'));
        // Destroy, not close: a stream still pending on a session that never
        // connected has nothing to cancel on the wire, and would sit there.
        req.destroy();
        // And if the session itself never connected, it won't: destroying it
        // keeps it from the next push (and fails anything else pending on it).
        if (client.connecting) client.destroy();
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
    // Resolved only on Apple's 200 (above); the push log records it as such.
    return 200;
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
    if (isProviderTokenRejection(status, reason)) return 'transient';
    if (reason && CONFIG_REJECTIONS.has(reason)) return 'transient';

    // Apple throttling us, Apple being down, or no response at all. IdleTimeout
    // is Apple closing our idle connection — nothing to do with the device.
    if (reason === 'IdleTimeout') return 'transient';
    if (status == null || status === 429 || status >= 500) return 'transient';
    return 'strike';
  },

  onFailure(err: unknown): void {
    const e = err as Partial<ApnsError>;
    // The cached token may simply have aged out against a clock skew, so drop it
    // and let the next attempt mint a fresh one rather than replay a dead one.
    //
    // Deliberately NOT on a bare 429: TooManyProviderTokenUpdates is Apple
    // telling us we are minting too often, and re-minting in response is the one
    // move guaranteed to keep it true.
    if (isProviderTokenRejection(e?.status ?? null, e?.reason ?? null)) providerToken.reset();
  },

  describe(err: unknown): string {
    const e = err as Partial<ApnsError>;
    return `status=${e?.status ?? '?'} reason=${e?.reason ?? '?'} message=${e?.message || String(err)}`;
  },
};
