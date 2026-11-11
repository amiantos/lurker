// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { searchMessagesOffLoop } from '../services/searchRunner.js';
import { feedFilters, feedLimit, goneSignal, positiveInt, sendFeedError } from './feedParams.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req: Request, res: Response) => {
  const limit = feedLimit(req);

  // Highlights are matched messages; the optional q / nick / target / networkId
  // params are the same from:/in:/on: + free-text filters search uses, so this
  // shares searchMessages() (FTS index included) rather than a parallel query
  // — and, taking free text, runs where search runs: off the event loop.
  const gone = goneSignal(res);
  let items;
  try {
    items = await searchMessagesOffLoop(
      req.user!.id,
      { matched: true, ...feedFilters(req), before: positiveInt(req.query.before), limit },
      gone,
    );
  } catch (err) {
    if (sendFeedError(res, gone, err)) return;
    throw err;
  }
  // Cursor for the next page is the id of the oldest row in this page; null
  // when the page didn't fill the limit (there's nothing older).
  const nextBefore = items.length === limit ? items[items.length - 1].id : null;
  res.json({ items, nextBefore });
});

export default router;
