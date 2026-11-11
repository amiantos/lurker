// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listActivity } from '../services/activityFeed.js';
import { feedFilters, feedLimit, goneSignal, positiveInt, sendFeedError } from './feedParams.js';

const router = Router();
router.use(requireAuth);

// The activity feed (services/activityFeed.ts): highlights and reactions to
// the user's lines, newest first, with the same from:/in:/on: + free-text
// filters as the highlights feed. The cursor is a pair, one per source; the
// response hands back the next pair, or null when there's nothing older.
router.get('/', async (req: Request, res: Response) => {
  const gone = goneSignal(res);
  let page;
  try {
    page = await listActivity(
      req.user!.id,
      feedFilters(req),
      {
        beforeMessage: positiveInt(req.query.beforeMessage),
        beforeReaction: positiveInt(req.query.beforeReaction),
      },
      feedLimit(req),
      gone,
    );
  } catch (err) {
    if (sendFeedError(res, gone, err)) return;
    throw err;
  }
  res.json({ items: page.items, next: page.next });
});

export default router;
