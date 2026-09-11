// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { EngineLink, engineConfigured } from '../services/engineLink.js';

const router = Router();
router.use(requireAuth);

// What Settings → About says about this instance beyond the client's own build.
//
// `engine` is null when this process dials IRC itself: no LURKER_ENGINE_URL, or
// an engine that refused us, which turns engine mode off for the run. Otherwise
// it is the engine as of its last hello. Its `version` is the engine's own
// ENGINE_VERSION (server/engine/version.ts), the release that last changed the
// engine, so it can trail the app's version — which is the point of showing it.
// null until the engine has answered once.
router.get('/', (_req: Request, res: Response) => {
  if (!engineConfigured()) {
    res.json({ engine: null });
    return;
  }
  const link = EngineLink.shared();
  res.json({ engine: { connected: link.state === 'ready', version: link.engineVersion } });
});

export default router;
