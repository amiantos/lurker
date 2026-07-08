// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getEdition } from '../utils/edition.js';
import { isNewAdminPanelEnabled } from '../utils/adminPanel.js';

const router = Router();

// Public, unauthenticated bootstrap config the client can read before login so
// the UI can branch on deployment edition (self-hosted vs hosted node) and other
// instance-level feature flags. Keep this lean and strictly non-sensitive — it is
// served to anyone who hits the origin. `newAdminPanel` gates the dedicated admin
// surface (Milestone 4); it is just a UI toggle, and every admin route stays
// requireAdmin-gated regardless, so exposing the flag leaks nothing.
router.get('/', (_req: Request, res: Response) => {
  res.json({ edition: getEdition(), newAdminPanel: isNewAdminPanelEnabled() });
});

export default router;
