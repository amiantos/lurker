// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Lifecycle for per-user data-export jobs.
//
// A request to export account data creates a data_exports row and kicks off a
// background build that writes a .lurk archive to data/exports/<token>.lurk;
// this module updates the row, relays progress to the user's open tabs over the
// WebSocket, and serves the lifecycle endpoints.
//
// The build runs IN-PROCESS via buildExportZip, which streams messages in
// keyset-paginated pages and yields to the event loop between them (see
// exportService). That's what keeps it off the critical path without a worker
// thread: no long-lived cursor is held on the shared connection (so a
// concurrent IRC write can't crash the process — lurker#175) and the loop stays
// responsive on a large export. We deliberately do NOT use worker_threads: tsx's
// module resolution doesn't propagate into worker threads on Node 22 (the
// deployed runtime), so a worker entry can't import the app's `.js`-specified
// TS modules there.

import fs from 'node:fs';
import path from 'node:path';
import db, { DATABASE_FILE } from '../db/index.js';
import { fanOutToUser } from './wsHub.js';
import { buildExportFilename, buildExportZip, countExportMessages } from './exportService.js';
import * as systemLog from './systemLog.js';
import {
  createExportJob,
  getExportJob,
  getActiveJobForUser,
  markRunning,
  updateProgress,
  markDone,
  markError,
  listExpiredJobs,
  listInflightJobs,
  listSupersededDoneJobs,
  deleteJob,
  type ExportJob,
} from '../db/dataExports.js';

// Artifacts live next to the database, under data/exports/. data/ is already
// gitignored; the dir is created 0700 (owner-only) on boot.
const EXPORTS_DIR = path.join(path.dirname(DATABASE_FILE), 'exports');
// How long a finished artifact survives before the sweep deletes it. Generous
// enough to re-download from another device, short enough that a file full of
// decrypted network passwords doesn't linger.
const TTL_HOURS = 24;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// WS fan-out is throttled to this cadence (the builder reports once per page);
// status changes always emit immediately.
const PROGRESS_THROTTLE_MS = 800;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
const lastEmitAt = new Map<number, number>();

function ensureExportsDir(): void {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true, mode: 0o700 });
}

function artifactPath(token: string): string {
  return path.join(EXPORTS_DIR, `${token}.lurk`);
}

function safeUnlink(filePath: string | null | undefined): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    /* already gone */
  }
}

function getUsername(userId: number): string {
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as
    | { username: string }
    | undefined;
  return row?.username || 'user';
}

// SQLite stores datetimes as 'YYYY-MM-DD HH:MM:SS' in UTC. Hand the client an
// ISO-8601 UTC string it can parse and render relatively.
function toIso(sqliteDatetime: string | null): string | null {
  return sqliteDatetime ? sqliteDatetime.replace(' ', 'T') + 'Z' : null;
}

/** Serialize a job row into the shape the client store/WS consume. */
export function toClientJob(row: ExportJob): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    includeMessages: !!row.include_messages,
    total: row.total_rows,
    processed: row.processed_rows,
    filename: row.filename,
    byteSize: row.byte_size,
    error: row.error,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    downloadable: row.status === 'done',
  };
}

function emit(userId: number, jobId: number): void {
  const row = getExportJob(jobId);
  if (!row) return;
  fanOutToUser(userId, { kind: 'export', job: toClientJob(row) });
}

function relayProgress(jobId: number, userId: number, processed: number, total: number): void {
  updateProgress(jobId, processed, total);
  const now = Date.now();
  if (now - (lastEmitAt.get(jobId) ?? 0) < PROGRESS_THROTTLE_MS) return;
  lastEmitAt.set(jobId, now);
  emit(userId, jobId);
}

// Build the archive in-process. buildExportZip streams messages in paged
// chunks and yields to the loop between them, so this coexists with live IRC
// traffic on the shared connection without holding a cursor open or starving
// the loop. The artifact is 0600 — it carries decrypted network passwords and
// is only handed back over the authenticated download endpoint.
async function runBuild(
  job: ExportJob,
  opts: { userId: number; includeMessages: boolean; outPath: string; filename: string },
): Promise<void> {
  try {
    const out = fs.createWriteStream(opts.outPath, { mode: 0o600 });
    await buildExportZip(
      db,
      opts.userId,
      { includeMessages: opts.includeMessages },
      out,
      (processed, total) => relayProgress(job.id, opts.userId, processed, total),
    );
    const byteSize = fs.statSync(opts.outPath).size;
    markDone(job.id, {
      filePath: opts.outPath,
      filename: opts.filename,
      byteSize,
      ttlHours: TTL_HOURS,
    });
    // Keep only the freshest export per user — delete the artifacts (and rows)
    // of any earlier completed job.
    for (const old of listSupersededDoneJobs(opts.userId, job.id)) {
      safeUnlink(old.file_path);
      deleteJob(old.id);
    }
    emit(opts.userId, job.id);
  } catch (err) {
    markError(job.id, err instanceof Error ? err.message : String(err));
    safeUnlink(opts.outPath);
    emit(opts.userId, job.id);
    systemLog.log({
      scope: 'export',
      level: 'warn',
      text: `Export job ${job.id} failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    lastEmitAt.delete(job.id);
  }
}

/**
 * Start an export for `userId`. Refuses (returns the existing job) if one is
 * already pending/running — one export at a time per user. The heavy build
 * runs in the background; this returns as soon as the job row exists.
 */
export function startExport(
  userId: number,
  includeMessages: boolean,
): { job: ExportJob; alreadyRunning: boolean } {
  const active = getActiveJobForUser(userId);
  if (active) return { job: active, alreadyRunning: true };

  ensureExportsDir();
  const job = createExportJob(userId, includeMessages);
  const total = includeMessages ? countExportMessages(db, userId) : 0;
  markRunning(job.id, total);
  const outPath = artifactPath(job.token);
  const filename = buildExportFilename(getUsername(userId), { includeMessages });
  emit(userId, job.id);

  // Fire-and-forget; runBuild owns all terminal state transitions + WS events.
  void runBuild(getExportJob(job.id)!, { userId, includeMessages, outPath, filename });
  return { job: getExportJob(job.id)!, alreadyRunning: false };
}

/** Delete expired artifacts + their rows. Called on an interval and on boot. */
export function sweepExpiredExports(): number {
  let removed = 0;
  for (const job of listExpiredJobs()) {
    safeUnlink(job.file_path);
    deleteJob(job.id);
    removed += 1;
  }
  return removed;
}

// Delete any file in the exports dir that no live row claims — partials left by
// a crash, or artifacts whose row was already swept.
function sweepOrphanFiles(): void {
  let names: string[];
  try {
    names = fs.readdirSync(EXPORTS_DIR);
  } catch (_) {
    return; // dir doesn't exist yet
  }
  const claimed = new Set(
    (db.prepare(`SELECT token FROM data_exports`).all() as { token: string }[]).map(
      (r) => `${r.token}.lurk`,
    ),
  );
  for (const name of names) {
    if (!claimed.has(name)) safeUnlink(path.join(EXPORTS_DIR, name));
  }
}

/**
 * Boot recovery: any job still marked pending/running was orphaned by a
 * restart (its in-process build was abandoned when the process exited). Fail
 * it, drop its partial file, then sweep expired artifacts and orphan files.
 * Call once at startup.
 */
export function recoverInterruptedExports(): void {
  ensureExportsDir();
  for (const job of listInflightJobs()) {
    safeUnlink(artifactPath(job.token));
    markError(job.id, 'interrupted by a server restart');
  }
  sweepExpiredExports();
  sweepOrphanFiles();
}

export function startExportSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepExpiredExports, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopExportSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// Stop the sweeper on graceful shutdown. An in-flight in-process build is
// simply abandoned when the process exits; boot recovery fails its orphaned
// row and removes the partial artifact on next start.
export function shutdownExportJobs(): void {
  stopExportSweeper();
}

/** The absolute path an artifact would live at — used by the download route. */
export function exportArtifactPath(token: string): string {
  return artifactPath(token);
}
