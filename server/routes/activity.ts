// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listActivity } from '../services/activityFeed.js';
import { feedFilters, feedLimit, positiveInt } from './feedParams.js';

const router = Router();
router.use(requireAuth);

// The activity feed (services/activityFeed.ts): highlights and reactions to
// the user's lines, newest first, with the same from:/in:/on: + free-text
// filters as the highlights feed. The cursor is a pair, one per source; the
// response hands back the next pair, or null when there's nothing older.
router.get('/', (req: Request, res: Response) => {
  const { items, next } = listActivity(
    req.user!.id,
    feedFilters(req),
    {
      beforeMessage: positiveInt(req.query.beforeMessage),
      beforeReaction: positiveInt(req.query.beforeReaction),
    },
    feedLimit(req),
  );
  res.json({ items, next });
});

export default router;
