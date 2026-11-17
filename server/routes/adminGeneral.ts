// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin → General: instance-wide settings with no pane of their own. One
// today, the Jitsi Meet server /jitsi starts calls on (#527). Mounted under
// routes/admin.ts, so requireAuth + requireAdmin are inherited.
//
// Both editions: a hosted customer is the admin of their own cell, and where
// their calls go is theirs to say.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { instanceJitsiUrl, setInstanceJitsiUrl } from '../db/instanceSettings.js';
import { fanOutJitsiUrlToAll } from '../services/wsHub.js';
import { normalizeJitsiBase } from '../../shared/jitsi.js';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ jitsiUrl: instanceJitsiUrl() });
});

// `{url}`: a Jitsi Meet base URL, or '' to go back to the public server.
router.put('/jitsi', (req: Request, res: Response) => {
  const raw = (req.body as { url?: unknown } | null)?.url;
  if (typeof raw !== 'string') {
    res.status(400).json({ error: 'url must be a string' });
    return;
  }
  const url = normalizeJitsiBase(raw);
  if (raw.trim() && !url) {
    res.status(400).json({ error: 'not a Jitsi address: expected https://host' });
    return;
  }
  // Unchanged (the same address retyped): nothing to store or announce.
  if (url !== instanceJitsiUrl()) {
    setInstanceJitsiUrl(url);
    fanOutJitsiUrlToAll();
  }
  res.json({ jitsiUrl: instanceJitsiUrl() });
});

export default router;
