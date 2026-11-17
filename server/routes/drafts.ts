// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import express from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { ownsNetwork } from '../db/networks.js';
import draftsService, { parseDraftGuard } from '../services/draftsService.js';
import { parseDraftReplyRef } from '../../shared/replies.js';

const router = Router();

// `sendBeacon` ships a Blob, and the CORS-safelist excludes application/json,
// so the client uses a text/plain Blob with a JSON string body. express.text
// here picks that up regardless of Content-Type — the request body arrives as
// a raw string and we JSON.parse it ourselves.
const beaconBody = express.text({ type: '*/*', limit: '512kb' });

// POST /api/drafts/flush — last-ditch save on tab close (or any other
// fire-and-forget path where the WS may already be tearing down). The body
// is `{ drafts: [{ networkId, target, body, reply? }, ...] }`. Each entry routes
// through draftsService.set, which decides what an empty body means (a reply
// with no text yet is still a draft). Updates fan out via
// the standard WS path so other open tabs see the new state.
router.post('/flush', requireAuth, beaconBody, (req: Request, res: Response) => {
  let payload: { drafts?: unknown[] } | undefined;
  try {
    payload = req.body ? (JSON.parse(req.body as string) as { drafts?: unknown[] }) : {};
  } catch (_) {
    res.status(400).json({ error: 'invalid json' });
    return;
  }
  const items = Array.isArray(payload?.drafts) ? payload.drafts : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const networkId = Number(entry.networkId);
    const target = typeof entry.target === 'string' ? entry.target : '';
    const body = typeof entry.body === 'string' ? entry.body : '';
    if (!Number.isInteger(networkId) || networkId <= 0) continue;
    if (!target || target.startsWith(':server:')) continue;
    if (!ownsNetwork(req.user!.id, networkId)) continue;
    // `base` / `age` as on `draft-set`: a beacon from a page that was long
    // offline must not put its text over a newer draft. A refusal is silent.
    draftsService.set(
      req.user!.id,
      networkId,
      target,
      body,
      parseDraftReplyRef(entry.reply),
      null,
      parseDraftGuard(entry),
    );
  }
  res.status(204).end();
});

export default router;
