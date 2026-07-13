// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What the network picker needs from the server, in one authenticated GET (#298).
//
// Only the *instance* presets travel over the wire — the 95 bundled builtins are
// already in the client bundle, and shipping them again on every boot would be
// pure waste. The client merges the two lists, instance presets first.
//
// The policy rides along on this GET rather than living in /api/config, matching
// how the uploader system surfaces allowUserDefined on GET /api/uploaders:
// /api/config is unauthenticated and served to anyone who hits the origin, so an
// instance policy has no business being there.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listEnabledInstanceNetworks } from '../db/instanceNetworks.js';
import { allowUserDefinedNetworks } from '../db/instanceSettings.js';

const router = Router();
router.use(requireAuth);

router.get('/', (_req: Request, res: Response) => {
  res.json({
    presets: listEnabledInstanceNetworks(),
    allowUserDefined: allowUserDefinedNetworks(),
  });
});

export default router;
