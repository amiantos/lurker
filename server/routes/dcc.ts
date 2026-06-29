// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC download-manager API (#270 phase 2). Lists the user's transfers and acts on
// them (accept a pending offer, reject it, cancel an in-flight one). The list is
// the Transfers view's initial load; live updates arrive over the WS as
// `dcc-transfer` frames. All routes are user-scoped via requireAuth.

import { Router, type Request, type Response } from 'express';

import { requireAuth, blockWritesWhenPaused } from '../middleware/auth.js';
import ircManager from '../services/ircManager.js';
import { dccEnabledForUser } from '../services/dccConfig.js';
import { getDccTransfer, listDccTransfers } from '../db/dccTransfers.js';

const router = Router();
router.use(requireAuth);

// The two-tier DCC gate (cell master switch AND per-user capability) guards
// every DCC entry point — the inbound-CTCP path checks it, so the API must too,
// or a stale pending_approval row could be accepted after a grant is revoked.
// Gating reads as well as writes keeps the whole surface dark when DCC is off
// (and gives the /dcc command + Transfers modal a clear "not enabled" error).
router.use((req: Request, res: Response, next) => {
  if (!dccEnabledForUser(req.user!.id)) {
    res.status(403).json({ error: 'DCC is not enabled for this account' });
    return;
  }
  next();
});

// A transfer id is a positive integer row id; reject anything else up front so a
// non-numeric :id can't reach better-sqlite3 as NaN (which throws → 500).
function transferId(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/dcc — the user's transfers, newest first. */
router.get('/', (req: Request, res: Response) => {
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  res.json({ transfers: listDccTransfers(req.user!.id, { limit }) });
});

// Acting on a transfer is a write — blocked for paused accounts (the list isn't).
router.use(blockWritesWhenPaused);

/** POST /api/dcc/:id/accept — accept a pending offer and start the download. */
router.post('/:id/accept', (req: Request, res: Response) => {
  const id = transferId(req);
  if (id == null) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  const result = ircManager.acceptDccTransfer(req.user!.id, id);
  if (result === 'not-found') {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  if (result === 'not-pending') {
    res.status(409).json({ error: 'transfer is not awaiting approval' });
    return;
  }
  if (result === 'not-connected') {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

/** POST /api/dcc/:id/reject — reject a pending offer (no download). */
router.post('/:id/reject', (req: Request, res: Response) => {
  const id = transferId(req);
  if (id == null || !ircManager.rejectDccTransfer(req.user!.id, id)) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

/** POST /api/dcc/:id/cancel — cancel an in-flight or still-pending transfer. */
router.post('/:id/cancel', (req: Request, res: Response) => {
  const id = transferId(req);
  if (id == null || !ircManager.cancelDccTransfer(req.user!.id, id)) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

export default router;
