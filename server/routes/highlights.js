import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { listUserHighlights } from '../db/messages.js';

const router = Router();
router.use(requireAuth);

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

router.get('/', (req, res) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;
  const rawBefore = Number(req.query.before);
  const before = Number.isFinite(rawBefore) && rawBefore > 0 ? rawBefore : undefined;

  const items = listUserHighlights(req.user.id, { before, limit });
  // Cursor for the next page is the id of the oldest row in this page; null
  // when the page didn't fill the limit (there's nothing older).
  const nextBefore = items.length === limit ? items[items.length - 1].id : null;
  res.json({ items, nextBefore });
});

export default router;
