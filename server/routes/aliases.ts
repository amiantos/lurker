// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import aliasesService from '../services/aliasesService.js';

// Command aliases (#276). Keyed by name: a name is one URL-safe word once
// normalized, and it is what the `/alias` command has in hand.

const router = Router();
router.use(requireAuth);

const nameOf = (req: Request): string => String(req.params.name ?? '');

router.get('/', (req: Request, res: Response) => {
  res.json({ aliases: aliasesService.list(req.user!.id) });
});

// Define, or replace the one of that name.
router.put('/:name', (req: Request, res: Response) => {
  const result = aliasesService.set(req.user!.id, nameOf(req), req.body?.body);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(result.created ? 201 : 200).json({ alias: result.alias, created: !!result.created });
});

// Edit in place: `name` renames, `body` rewrites.
router.patch('/:name', (req: Request, res: Response) => {
  const result = aliasesService.update(req.user!.id, nameOf(req), req.body || {});
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ alias: result.alias });
});

router.delete('/:name', (req: Request, res: Response) => {
  const result = aliasesService.remove(req.user!.id, nameOf(req));
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

export default router;
