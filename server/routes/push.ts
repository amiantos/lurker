// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getPublicKey } from '../services/pushService.js';
import {
  upsertSubscription,
  deleteByEndpoint,
  listAllForUser,
  heartbeatByEndpoint,
} from '../db/pushSubscriptions.js';

const router = Router();
router.use(requireAuth);

router.get('/config', (_req: Request, res: Response) => {
  res.json({ publicKey: getPublicKey() });
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
