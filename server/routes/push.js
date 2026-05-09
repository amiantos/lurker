import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getPublicKey } from '../services/pushService.js';
import {
  upsertSubscription,
  deleteByEndpoint,
  listAllForUser,
} from '../db/pushSubscriptions.js';

const router = Router();
router.use(requireAuth);

router.get('/config', (req, res) => {
  res.json({ publicKey: getPublicKey() });
});

router.get('/subscriptions', (req, res) => {
  const subs = listAllForUser(req.user.id).map((s) => ({
    id: s.id,
    endpoint: s.endpoint,
    user_agent: s.user_agent,
    enabled: s.enabled,
    created_at: s.created_at,
    last_seen_at: s.last_seen_at,
  }));
  res.json({ subscriptions: subs });
});

router.post('/subscriptions', (req, res) => {
  const { endpoint, keys, userAgent } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'endpoint and keys.p256dh + keys.auth are required' });
  }
  const sub = upsertSubscription(req.user.id, {
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent: userAgent || req.headers['user-agent'] || null,
  });
  res.status(201).json({ subscription: { id: sub.id, endpoint: sub.endpoint } });
});

router.delete('/subscriptions', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  deleteByEndpoint(req.user.id, endpoint);
  res.json({ ok: true });
});

export default router;
