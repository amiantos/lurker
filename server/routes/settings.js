// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { REGISTRY } from '../services/settingsRegistry.js';
import { getUserSettings } from '../db/settings.js';
import settingsService from '../services/settingsService.js';

const router = Router();
router.use(requireAuth);

router.get('/bootstrap', (req, res) => {
  res.json({
    registry: REGISTRY,
    values: getUserSettings(req.user.id),
  });
});

router.patch('/', (req, res) => {
  const changes = req.body?.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return res.status(400).json({ error: 'changes must be an object of { key: value }' });
  }
  const result = settingsService.update(req.user.id, changes);
  if (!result.ok) return res.status(400).json({ error: result.error, key: result.key });
  res.json({ values: result.values });
});

router.delete('/:key', (req, res) => {
  const result = settingsService.reset(req.user.id, req.params.key);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ values: result.values });
});

export default router;
