// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getPublicKey } from '../services/pushService.js';
import { senderFor } from '../services/push/index.js';
import {
  upsertSubscription,
  deleteByEndpoint,
  listAllForUser,
  heartbeatByEndpoint,
  isNativeTransport,
  NATIVE_TRANSPORTS,
  PUSH_TRANSPORTS,
  type NativeTransport,
} from '../db/pushSubscriptions.js';

const router = Router();
router.use(requireAuth);

// A device token is provider-issued and has a known shape, so validate it as one
// rather than accepting any bounded string. It is untrusted input that reaches
// the APNs request path (`/3/device/${token}`), and Node's http2 neither
// validates nor encodes `:path` — an unchecked token is a request-path injection
// against Apple's gateway carrying our own provider JWT (review of #490).
//
// Deliberately a little loose on length: an APNs token is 32 bytes / 64 hex
// today, but Apple has said it may grow, and rejecting a longer one would break
// push on a future iOS with no way for an operator to tell why.
const TOKEN_SHAPES: Record<NativeTransport, RegExp> = {
  // Hex, and only hex.
  apns: /^[0-9a-fA-F]{64,200}$/,
  // An FCM registration token is `<instance-id>:<APA91b…>` — base64url plus the
  // colon separator and dots seen in older tokens.
  fcm: /^[A-Za-z0-9_:.-]{64,4096}$/,
};

router.get('/config', (_req: Request, res: Response) => {
  // `transports` tells a client what this server can ACTUALLY deliver on, which
  // is not knowable from the app's own build (#490). A self-hosted server holds
  // no Apple key and reports ['webpush'] — so the iOS app can say so plainly
  // instead of asking for notification permission and then silently never
  // delivering. publicKey stays for Web Push and is meaningless to native.
  const transports = PUSH_TRANSPORTS.filter((t) => senderFor(t).isConfigured());
  res.json({ publicKey: getPublicKey(), transports });
});

// Native device registration (#490 phase 4). Separate from /subscriptions rather
// than an overload of it: there are no `keys` here, and the cross-user collision
// rule is the opposite — see upsertSubscription.
router.post('/devices', (req: Request, res: Response) => {
  const { token, transport } = req.body || {};
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  // 'webpush' is deliberately not accepted here. It would file a Web Push row
  // with no keypair, which is undeliverable AND unrepresentable — every later
  // read would skip it, so push would silently never arrive.
  if (!isNativeTransport(transport)) {
    res.status(400).json({ error: `transport must be one of: ${NATIVE_TRANSPORTS.join(', ')}` });
    return;
  }
  if (!TOKEN_SHAPES[transport].test(token)) {
    res.status(400).json({ error: `token is not a valid ${transport} device token` });
    return;
  }
  // Registering against a server that can't deliver is a real case, not an edge
  // one: a self-hoster's user running the App Store build. Say so rather than
  // accepting a row that will never push.
  if (!senderFor(transport).isConfigured()) {
    res.status(503).json({
      error: `this server is not configured for ${transport} push`,
      transport,
    });
    return;
  }
  const result = upsertSubscription(req.user!.id, {
    transport,
    endpoint: token,
    userAgent: req.headers['user-agent'] || null,
  });
  if (!result.ok || !result.sub) {
    // upsertSubscription rebinds rather than refusing for native, so !ok here is
    // not the cross-user case — it's a genuine storage failure.
    res.status(500).json({ error: 'device could not be registered' });
    return;
  }
  res.status(201).json({ device: { id: result.sub.id, transport: result.sub.transport } });
});

// Deregister on sign-out. The app is expected to call this BEFORE /auth/logout,
// while it still has a session to authenticate with. When that fails — a crash,
// a force-quit, no network — the token stays filed against the old account, and
// the native rebind rule in upsertSubscription is what stops that from stranding
// the next user who signs in on the phone.
router.delete('/devices', (req: Request, res: Response) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  deleteByEndpoint(req.user!.id, token);
  res.json({ ok: true });
});

router.get('/subscriptions', (req: Request, res: Response) => {
  // Keys are deliberately never projected. `transport` is, so a client can tell
  // a browser subscription from a phone when listing devices.
  const subs = listAllForUser(req.user!.id).map((s) => ({
    id: s.id,
    endpoint: s.endpoint,
    transport: s.transport,
    user_agent: s.user_agent,
    enabled: s.enabled,
    created_at: s.created_at,
    last_seen_at: s.last_seen_at,
  }));
  res.json({ subscriptions: subs });
});

// Web Push registration. Native (APNs/FCM) device registration is its own route
// (#490 phase 4) rather than an overload of this one: it has no `keys`, and its
// cross-user collision rule is the opposite of this one's.
router.post('/subscriptions', (req: Request, res: Response) => {
  const { endpoint, keys, userAgent } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    res.status(400).json({ error: 'endpoint and keys.p256dh + keys.auth are required' });
    return;
  }
  const result = upsertSubscription(req.user!.id, {
    transport: 'webpush',
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent: userAgent || req.headers['user-agent'] || null,
  });
  if (!result.ok) {
    res.status(409).json({
      error:
        'this browser is already registered for push under another account; disable push there first',
    });
    return;
  }
  if (!result.sub) {
    // The row was written and immediately failed to read back — corrupt enough
    // that reporting success would be a lie.
    res.status(500).json({ error: 'subscription could not be stored' });
    return;
  }
  res.status(201).json({ subscription: { id: result.sub.id, endpoint: result.sub.endpoint } });
});

router.delete('/subscriptions', (req: Request, res: Response) => {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    res.status(400).json({ error: 'endpoint required' });
    return;
  }
  deleteByEndpoint(req.user!.id, endpoint);
  res.json({ ok: true });
});

router.post('/heartbeat', (req: Request, res: Response) => {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    res.status(400).json({ error: 'endpoint required' });
    return;
  }
  const updated = heartbeatByEndpoint(req.user!.id, endpoint);
  res.json({ ok: true, present: updated });
});

export default router;
