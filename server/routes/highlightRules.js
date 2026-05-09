import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import highlightRulesService from '../services/highlightRulesService.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const rules = highlightRulesService.list(req.user.id);
  res.json({ rules });
});

router.post('/', (req, res) => {
  const result = highlightRulesService.create(req.user.id, req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(201).json({ rule: result.rule });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const result = highlightRulesService.update(id, req.user.id, req.body || {});
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
  res.json({ rule: result.rule });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const result = highlightRulesService.remove(id, req.user.id);
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
  res.json({ ok: true });
});

export default router;
