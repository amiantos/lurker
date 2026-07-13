// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-user data export/import endpoints.
//
// Export is asynchronous: POST starts a background build (a worker thread on
// its own readonly db connection — see services/exportJobs.ts), progress is
// pushed over the WebSocket, and the finished .lurk artifact is fetched from a
// separate authenticated, resumable download endpoint. Building the zip inline
// on the request (and on the shared db connection) is what crashed the process
// on large exports — lurker#175.
//
// Import restores an export zip into a fresh account. See
// server/db/exportSchema.js for the per-table contract that drives both
// directions.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import db from '../db/index.js';
import { computeExportPreview } from '../services/exportService.js';
import { startExport, toClientJob, exportArtifactPath } from '../services/exportJobs.js';
import { getLatestJobForUser, getExportJobForUser, markDownloaded } from '../db/dataExports.js';
import { importFromZipFile, ImportError } from '../services/importService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
router.use(requireAuth);

function parseBool(v: unknown): boolean {
  const s = String(v ?? '').toLowerCase();
  return v === true || s === '1' || s === 'true';
}

// GET /api/exports/preview — return row counts for both flavors so the
// client can show what's about to be downloaded.
router.get('/preview', (req: Request, res: Response, next: NextFunction) => {
  try {
    const settingsOnly = computeExportPreview(db, req.user!.id, { includeMessages: false });
    const withMessages = computeExportPreview(db, req.user!.id, { includeMessages: true });
    res.json({
      settingsOnly,
      withMessages,
      username: req.user!.username,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/exports/latest — the user's most recent export job (any status), so
// the client can restore "preparing…" / "ready to download" on page load.
router.get('/latest', (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = getLatestJobForUser(req.user!.id);
    res.json({ job: job ? toClientJob(job) : null });
  } catch (err) {
    next(err);
  }
});

// POST /api/exports { include_messages } — start a background export. Refuses
// to start a second concurrent build for the same user (returns the in-flight
// job with alreadyRunning=true). Allowed for paused accounts too: exporting
// your own data is the one thing a suspended user must always be able to do.
router.post('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    const includeMessages = parseBool(req.body?.include_messages ?? req.query.include_messages);
    const { job, alreadyRunning } = startExport(req.user!.id, includeMessages);
    res.status(alreadyRunning ? 200 : 202).json({ job: toClientJob(job), alreadyRunning });
  } catch (err) {
    next(err);
  }
});

// GET /api/exports/:id/download — stream a finished artifact. Authenticated +
// ownership-checked; supports HTTP Range (via res.download → sendFile) so an
// interrupted download resumes instead of restarting.
router.get('/:id/download', (req: Request, res: Response, next: NextFunction) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'bad export id' });
    return;
  }
  const job = getExportJobForUser(id, req.user!.id);
  if (!job) {
    res.status(404).json({ error: 'export not found' });
    return;
  }
  if (job.status !== 'done') {
    res.status(409).json({ error: 'export is not ready', status: job.status });
    return;
  }
  const filePath = job.file_path || exportArtifactPath(job.token);
  if (!fs.existsSync(filePath)) {
    // Row says done but the artifact is gone (expired sweep, or a stale row).
    res.status(410).json({ error: 'export artifact is no longer available' });
    return;
  }
  // res.download sets Content-Disposition: attachment and an octet-stream
  // Content-Type for the unknown .lurk extension (so Safari won't try to
  // auto-unarchive it), and honors Range requests.
  res.download(filePath, job.filename || 'lurker-export.lurk', (err) => {
    if (err) {
      // Client aborted or the file vanished mid-send; headers are likely out.
      if (!res.headersSent) next(err);
      return;
    }
    markDownloaded(job.id);
  });
});

const importRouter = Router();
importRouter.use(requireAuth);

// Cap import zip size. 500 MB is generous for "a single user's logs"; if a
// user trips this we want to see the report rather than silently accept
// something unbounded. The upload streams to a temp file (not memory) and the
// importer reads it from disk, so peak memory stays flat regardless of size.
const HARD_IMPORT_LIMIT = 500 * 1024 * 1024;
const IMPORT_TMP_DIR = path.join(os.tmpdir(), 'lurker-imports');
// Owner-only — an uploaded .lurk holds the source account's decrypted network
// passwords, so other local users on a shared host mustn't be able to read the
// staged upload. Matches the 0700/0600 posture on the export side.
fs.mkdirSync(IMPORT_TMP_DIR, { recursive: true, mode: 0o700 });
const upload = multer({
  dest: IMPORT_TMP_DIR,
  // See routes/uploads.ts: busboy's default param charset is latin-1, which mangles
  // any non-ASCII filename.
  defParamCharset: 'utf8',
  limits: { fileSize: HARD_IMPORT_LIMIT, files: 1 },
});

// POST /api/imports — upload an export zip and restore it into the
// caller's account. Refuses if the account already has data.
importRouter.post(
  '/',
  upload.single('archive'),
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'no archive uploaded' });
        return;
      }
      const result = await importFromZipFile(req.user!.id, req.file.path);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof ImportError) {
        // ImportError.code is assigned in the JS constructor — not in the TS type yet
        const e = err as ImportError & { code: string };
        const status =
          e.code === 'account_not_empty'
            ? 409
            : e.code === 'format_too_new'
              ? 400
              : e.code === 'not_a_zip'
                ? 400
                : e.code === 'missing_manifest'
                  ? 400
                  : e.code === 'missing_data'
                    ? 400
                    : e.code === 'bad_manifest'
                      ? 400
                      : e.code === 'bad_data'
                        ? 400
                        : e.code === 'bad_messages'
                          ? 400
                          : e.code === 'bad_bookmarks'
                            ? 400
                            : 500;
        res.status(status).json({ error: e.message, code: e.code });
        return;
      }
      next(err);
    } finally {
      // Drop the multer temp upload whether the import succeeded or failed.
      if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
    }
  }),
);

export { router as exportsRouter, importRouter };
