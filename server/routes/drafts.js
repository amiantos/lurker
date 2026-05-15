// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { Router } from 'express';
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { ownsNetwork } from '../db/networks.js';
import draftsService from '../services/draftsService.js';

const router = Router();

// `sendBeacon` ships a Blob, and the CORS-safelist excludes application/json,
// so the client uses a text/plain Blob with a JSON string body. express.text
// here picks that up regardless of Content-Type — the request body arrives as
// a raw string and we JSON.parse it ourselves.
const beaconBody = express.text({ type: '*/*', limit: '512kb' });

// POST /api/drafts/flush — last-ditch save on tab close (or any other
// fire-and-forget path where the WS may already be tearing down). The body
// is `{ drafts: [{ networkId, target, body }, ...] }`. Each entry routes
// through draftsService.set; empty bodies clear the row. Updates fan out via
// the standard WS path so other open tabs see the new state.
router.post('/flush', requireAuth, beaconBody, (req, res) => {
  let payload;
  try {
    payload = req.body ? JSON.parse(req.body) : {};
  } catch (_) {
    return res.status(400).json({ error: 'invalid json' });
  }
  const items = Array.isArray(payload?.drafts) ? payload.drafts : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const networkId = Number(item.networkId);
    const target = typeof item.target === 'string' ? item.target : '';
    const body = typeof item.body === 'string' ? item.body : '';
    if (!Number.isInteger(networkId) || networkId <= 0) continue;
    if (!target || target.startsWith(':server:')) continue;
    if (!ownsNetwork(req.user.id, networkId)) continue;
    draftsService.set(req.user.id, networkId, target, body, null);
  }
  res.status(204).end();
});

export default router;
