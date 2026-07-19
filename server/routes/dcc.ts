// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC download-manager API (#270 phase 2). Lists the user's transfers and acts on
// them (accept a pending offer, reject it, cancel an in-flight one). The list is
// the Transfers view's initial load; live updates arrive over the WS as
// `dcc-transfer` frames. All routes are user-scoped via requireAuth.

import fs from 'fs';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';

import { requireAuth } from '../middleware/auth.js';
import ircManager from '../services/ircManager.js';
import { dccEnabledForUser, dccMaxFileBytes } from '../services/dccConfig.js';
import { getDccTransfer, listDccTransfers } from '../db/dccTransfers.js';
import { getNetwork } from '../db/networks.js';
import { findUserById } from '../db/users.js';
import { resolveDccDestination, dccRoot, hasFreeSpaceFor } from '../services/dccPaths.js';
import path from 'path';

// Cap the web-UI "send a file" upload. DCC itself streams from disk, but this
// route buffers the upload in memory before writing it to the DCC dir, so bound
// it: the operator per-file cap when set, else a memory-safe default. Bigger
// sends aren't a web-upload concern (you'd stage the file on the box).
const DEFAULT_SEND_CEILING = 256 * 1024 * 1024;
function sendUploadCeiling(): number {
  const cap = dccMaxFileBytes();
  return cap > 0 ? Math.min(cap, 2 * 1024 * 1024 * 1024) : DEFAULT_SEND_CEILING;
}
const sendUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: sendUploadCeiling(), files: 1 },
});

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

// Acting on a transfer is a write — blocked for paused accounts (the list isn't)
// by the central requireAuth gate (#573); the GET list above stays available.

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

/**
 * POST /api/dcc/send — offer an uploaded file to a peer over DCC SEND. Multipart
 * body: `file` (the file), `networkId`, `nick`. The file is written into the
 * user's DCC directory, then offered; the peer receives it directly.
 */
router.post(
  '/send',
  blockWritesWhenPaused,
  (req: Request, res: Response, next) => {
    sendUpload.single('file')(req, res, (err: unknown) => {
      if (err) {
        const e = err as { code?: string; message?: string };
        const tooBig = e.code === 'LIMIT_FILE_SIZE';
        res.status(tooBig ? 413 : 400).json({
          error: tooBig
            ? `file exceeds the ${sendUploadCeiling() / (1024 * 1024)}MB send limit`
            : 'upload failed',
        });
        return;
      }
      next();
    });
  },
  (req: Request, res: Response) => {
    if (!dccRoot()) {
      res.status(503).json({ error: 'DCC directory is not configured on this server' });
      return;
    }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: 'no file uploaded' });
      return;
    }
    const networkId = Number(req.body?.networkId);
    const nick = typeof req.body?.nick === 'string' ? req.body.nick.trim() : '';
    if (!Number.isInteger(networkId) || networkId <= 0 || !nick) {
      res.status(400).json({ error: 'networkId and nick are required' });
      return;
    }
    // Ownership: a user can only send from their own network's connection.
    if (!getNetwork(networkId, req.user!.id)) {
      res.status(404).json({ error: 'network not found' });
      return;
    }
    const username = findUserById(req.user!.id)?.username || 'user';
    let destPath: string;
    try {
      destPath = resolveDccDestination(username, file.originalname || 'file');
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'bad filename' });
      return;
    }
    if (!hasFreeSpaceFor(path.dirname(destPath), file.size)) {
      res.status(507).json({ error: 'not enough free disk space' });
      return;
    }
    try {
      fs.writeFileSync(destPath, file.buffer, { flag: 'wx' });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'could not stage the file' });
      return;
    }
    const filename = path.basename(destPath);
    const id = ircManager.sendDccFile(req.user!.id, networkId, nick, destPath, filename, file.size);
    if (id == null) {
      // Network offline — drop the staged file so it doesn't orphan.
      try {
        fs.unlinkSync(destPath);
      } catch {
        /* best effort */
      }
      res.status(409).json({ error: 'network not connected' });
      return;
    }
    res.json({ transfer: getDccTransfer(req.user!.id, id) });
  },
);

// Shared parse for the JSON chat routes: {networkId, nick}, ownership-checked.
function chatTarget(req: Request, res: Response): { networkId: number; nick: string } | null {
  const networkId = Number(req.body?.networkId);
  const nick = typeof req.body?.nick === 'string' ? req.body.nick.trim() : '';
  if (!Number.isInteger(networkId) || networkId <= 0 || !nick) {
    res.status(400).json({ error: 'networkId and nick are required' });
    return null;
  }
  if (!getNetwork(networkId, req.user!.id)) {
    res.status(404).json({ error: 'network not found' });
    return null;
  }
  return { networkId, nick };
}

/** POST /api/dcc/chat — offer a DCC chat to a peer. Body: {networkId, nick}. */
router.post('/chat', blockWritesWhenPaused, (req: Request, res: Response) => {
  const t = chatTarget(req, res);
  if (!t) return;
  if (!ircManager.dccChatOpen(req.user!.id, t.networkId, t.nick)) {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ ok: true, target: `=${t.nick}` });
});

/** POST /api/dcc/chat/close — close a live DCC chat. Body: {networkId, nick}. */
router.post('/chat/close', blockWritesWhenPaused, (req: Request, res: Response) => {
  const t = chatTarget(req, res);
  if (!t) return;
  ircManager.dccChatClose(req.user!.id, t.networkId, t.nick);
  res.json({ ok: true });
});

export default router;
