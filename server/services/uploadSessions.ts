// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Chunked, resumable uploads (#650). A single-request upload can never be
// larger than the smallest request-body limit on the path (Cloudflare's 100 MB,
// an nginx client_max_body_size), and one that drops at 90% starts again. A
// session takes the file a chunk per request instead, each well under any
// proxy's limit, and appends it to a file on disk:
//
//   create   declares the size, checked against the purpose's cap before a
//            byte is sent
//   chunk    appends bytes at an offset, which must be exactly where the file
//            ends now; anything else is answered with the real offset
//   status   tells a client that lost track where to carry on, or, once the
//            session is done, what complete answered
//   complete hands the assembled file to what a single request would have
//            (the upload pipeline, the importer), or keeps it as a DCC file to
//            send (#1086), and keeps the answer
//
// The file's size IS the offset, so a chunk cut off halfway leaves a prefix
// of what was sent, and the client carries on from there. Complete can outlast
// a proxy's patience (a 500 MB import takes minutes, Cloudflare waits 100 s),
// so the session keeps its answer and a client that lost the response reads it
// from status; asking complete again replays it. A session survives a restart;
// one idle for a day is swept.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { resolveDataDir } from '../utils/dataDir.js';
import { hasFreeSpaceFor } from '../utils/diskSpace.js';
import {
  allUploadSessionIds,
  deleteUploadSession,
  getUploadSession,
  idleUploadSessionIds,
  insertUploadSession,
  markUploadSessionDone,
  markUploadSessionProcessing,
  openUploadSessions,
  touchUploadSession,
  type UploadPurpose,
  type UploadSessionResult,
  type UploadSessionRow,
  type UploadSessionState,
} from '../db/uploadSessions.js';
import {
  chunkedCapBytesFor,
  effectiveSettings,
  formatCapMb,
  MAX_IMPORT_BYTES,
  uploadChunkBytes,
} from './uploadLimits.js';
import {
  resolveUploader,
  UploaderNotConfiguredError,
  UploaderUnavailableError,
} from './uploadProviders/resolve.js';
import { accountIsEmpty } from './importService.js';
import { UploadRequestError } from './uploadService.js';
import { dccMaxFileBytes, dccSendEnabledForUser } from './dccConfig.js';
import { dccRoot } from './dccPaths.js';
import { dccUploadIsStale, dccUsageBytes, pendingDccUploadBytes } from '../db/dccTransfers.js';
import { getDccStorageLimit } from '../db/dccStorageLimits.js';
import { formatBytes } from './dcc.js';
import { findUserById, restrictionsOf } from '../db/users.js';
import { UPLOADS_RESTRICTED } from '../../shared/accountRestrictions.js';

/** Where sessions keep their bytes. Owner-only, files 0600: an import is an
 *  archive with the source account's network passwords in it. */
export const UPLOAD_SESSION_DIR = path.join(resolveDataDir(), 'tmp', 'upload-sessions');
fs.mkdirSync(UPLOAD_SESSION_DIR, { recursive: true, mode: 0o700 });
try {
  // mkdir leaves an existing directory's mode alone.
  fs.chmodSync(UPLOAD_SESSION_DIR, 0o700);
} catch {
  // A filesystem without POSIX modes; nothing to tighten.
}

/** A session with no activity for this long is abandoned. */
export const UPLOAD_SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

// Sessions with a request working on their file: a chunk being written, or the
// file being handed on. A second request for one of them is refused, because
// two writers appending at once would interleave their bytes.
const busy = new Set<string>();

export function uploadSessionPath(id: string): string {
  return path.join(UPLOAD_SESSION_DIR, id);
}

/** Bytes the session holds so far: its file's size. */
export function uploadSessionOffset(id: string): number {
  try {
    return fs.statSync(uploadSessionPath(id)).size;
  } catch {
    return 0;
  }
}

export interface UploadSessionStatus {
  id: string;
  purpose: UploadPurpose;
  size: number;
  offset: number;
  chunkBytes: number;
  state: UploadSessionState;
  /** What complete answered, once done. */
  result?: UploadSessionResult;
}

/** What a session left processing with nothing working on it answers: the
 *  process that was (stopped, or couldn't record its answer) is gone. */
const STRANDED: UploadSessionResult = {
  status: 500,
  body: { error: 'the server stopped while handling this file; send it again' },
};

/** Where a session stands. 'processing' only while a request here is working
 *  on it; otherwise it is over, and STRANDED is its answer. */
function standing(row: UploadSessionRow): {
  state: UploadSessionState;
  result?: UploadSessionResult;
} {
  if (row.state === 'processing' && !busy.has(row.id)) return { state: 'done', result: STRANDED };
  if (row.state === 'done') {
    return { state: 'done', result: row.result ? JSON.parse(row.result) : STRANDED };
  }
  return { state: row.state };
}

function statusOf(row: UploadSessionRow): UploadSessionStatus {
  const { state, result } = standing(row);
  return {
    id: row.id,
    purpose: row.purpose,
    size: row.size,
    // A done session's file is gone; it held all of it.
    offset: state === 'open' ? uploadSessionOffset(row.id) : row.size,
    chunkBytes: uploadChunkBytes(),
    state,
    ...(result ? { result } : {}),
  };
}

/** The caller's session, or a 404. */
export function requireUploadSession(userId: number, id: string): UploadSessionRow {
  const row = getUploadSession(userId, id);
  if (!row) throw new UploadRequestError(404, 'no such upload session');
  return row;
}

export function uploadSessionStatus(userId: number, id: string): UploadSessionStatus {
  return statusOf(requireUploadSession(userId, id));
}

/** Refuse a request for a session another request is working on. */
function assertIdle(id: string): void {
  if (busy.has(id)) {
    throw new UploadRequestError(409, 'this upload session is busy with another request', {
      code: 'session_busy',
      offset: uploadSessionOffset(id),
    });
  }
}

/** The largest file `purpose` takes for this user. An upload's cap is its
 *  uploader's (the override if one is named), without any proxy ceiling. */
function capFor(
  purpose: UploadPurpose,
  user: { id: number; isAdmin: boolean },
  uploaderId: number | null,
): number {
  if (purpose === 'import') return MAX_IMPORT_BYTES;
  // A file to send over DCC isn't an upload: no uploader, and not the upload
  // cap. It is a DCC file, under DCC's own cap (0 is none).
  if (purpose === 'dcc-send') return dccMaxFileBytes() || Number.MAX_SAFE_INTEGER;
  try {
    const { policy } = resolveUploader({
      userId: user.id,
      isAdmin: user.isAdmin,
      requestedId: uploaderId,
    });
    return chunkedCapBytesFor(policy, effectiveSettings(user.id));
  } catch (err) {
    // As processUpload answers them, so a session fails the way a single
    // request would, only before the bytes rather than after.
    if (err instanceof UploaderNotConfiguredError) throw new UploadRequestError(503, err.message);
    if (err instanceof UploaderUnavailableError) throw new UploadRequestError(400, err.message);
    throw err;
  }
}

/** Refuse a DCC file that would take the account past its limit (#1125):
 *  what it keeps or will still write, uploads under way included, plus this. */
function assertDccFits(userId: number, size: number): void {
  const limit = getDccStorageLimit(userId);
  if (limit === null) return;
  const used = dccUsageBytes(userId).committed;
  if (used + size > limit) {
    throw new UploadRequestError(
      413,
      `over your DCC storage limit (${formatBytes(used)} of ${formatBytes(limit)} used)`,
      { code: 'dcc_storage_limit' },
    );
  }
}

/** Whether two paths are on one filesystem. Unknown counts as not. */
function sameDisk(a: string, b: string): boolean {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
}

/** Bytes the open sessions will still write, every account's. Free disk is
 *  checked against these too, or ten sessions that each fit alone would
 *  together fill it. */
function bytesStillToCome(): number {
  let total = 0;
  for (const s of openUploadSessions()) total += Math.max(0, s.size - uploadSessionOffset(s.id));
  return total;
}

// The purposes that put a file on the instance's uploaders, which is what an
// account restriction withholds. An import stays on this disk and a DCC send
// goes peer-to-peer, so neither is the CDN and neither is gated here.
function refuseIfUploadsRestricted(userId: number, purpose: unknown): void {
  if (purpose !== 'upload' && purpose !== 'avatar') return;
  if (!restrictionsOf(findUserById(userId)).uploads) {
    throw new UploadRequestError(403, UPLOADS_RESTRICTED);
  }
}

export function createUploadSession(
  user: { id: number; isAdmin: boolean },
  body: Record<string, unknown>,
): UploadSessionStatus {
  const purpose = body.purpose;
  if (
    purpose !== 'upload' &&
    purpose !== 'avatar' &&
    purpose !== 'import' &&
    purpose !== 'dcc-send'
  ) {
    throw new UploadRequestError(400, "purpose must be 'upload', 'avatar', 'import' or 'dcc-send'");
  }
  refuseIfUploadsRestricted(user.id, purpose);
  if (purpose === 'dcc-send') {
    if (!dccSendEnabledForUser(user.id)) {
      throw new UploadRequestError(403, 'DCC sending is not enabled for this account');
    }
    if (!dccRoot()) {
      throw new UploadRequestError(
        503,
        'DCC download directory is not configured (set LURKER_DCC_DIR)',
      );
    }
  }
  const size = body.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new UploadRequestError(400, 'size must be a whole number of bytes above 0');
  }
  if (typeof body.filename !== 'string') {
    throw new UploadRequestError(400, 'filename must be a string');
  }
  // No control characters: the name goes into a provider's multipart header
  // and the uploads list (processUpload strips them too).
  const filename = body.filename.replace(/\p{Cc}/gu, '').slice(0, 255) || 'upload';
  const mime =
    typeof body.mime === 'string' && body.mime && body.mime.length <= 255 ? body.mime : null;
  let uploaderId: number | null = null;
  if (body.uploaderId != null) {
    if (purpose !== 'upload' || !Number.isInteger(body.uploaderId)) {
      throw new UploadRequestError(400, 'uploaderId must be an integer, on an upload');
    }
    uploaderId = body.uploaderId as number;
  }

  const cap = capFor(purpose, user, uploaderId);
  if (size > cap) {
    throw new UploadRequestError(
      413,
      purpose === 'import'
        ? `archive exceeds ${formatCapMb(cap)} MB`
        : `file exceeds ${formatCapMb(cap)} MB`,
      purpose === 'import' ? { code: 'archive_too_large' } : {},
    );
  }
  // The admin's per-user DCC limit (#1125), as accepting a received file
  // checks it: what the account keeps or will still write, sessions like this
  // one included, plus this file.
  if (purpose === 'dcc-send') {
    assertDccFits(user.id, size);
    // It moves from the session dir to the DCC folder. On another disk, that
    // one needs room for it and for the other uploads on their way there; on
    // the same disk, the session-dir check below already holds the bytes.
    if (!sameDisk(dccRoot()!, UPLOAD_SESSION_DIR)) {
      if (!hasFreeSpaceFor(dccRoot()!, size + pendingDccUploadBytes())) {
        throw new UploadRequestError(507, 'not enough free disk space on the server for this file');
      }
    }
  }
  // The importer refuses an account with data in it. Said now, not after the
  // archive has crossed the network.
  if (purpose === 'import' && !accountIsEmpty(user.id)) {
    throw new UploadRequestError(
      409,
      'target account already has data; imports require a fresh account',
      { code: 'account_not_empty' },
    );
  }
  if (!hasFreeSpaceFor(UPLOAD_SESSION_DIR, size + bytesStillToCome())) {
    throw new UploadRequestError(507, 'not enough free disk space on the server for this file');
  }

  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(uploadSessionPath(id), '', { flag: 'wx', mode: 0o600 });
  insertUploadSession(user.id, { id, purpose, size, filename, mime, uploaderId });
  return {
    id,
    purpose,
    size,
    offset: 0,
    chunkBytes: uploadChunkBytes(),
    state: 'open',
  };
}

/**
 * Append one chunk, read from `body`, at `offsetHeader`. Answers the offset
 * after it. A chunk cut off partway keeps what arrived, which is a prefix of
 * what was sent; the client asks for the offset and carries on.
 */
export async function appendUploadChunk(
  userId: number,
  id: string,
  offsetHeader: unknown,
  declaredLength: number | null,
  body: Readable,
): Promise<{ offset: number }> {
  const row = requireUploadSession(userId, id);
  assertIdle(id);
  if (row.state !== 'open') {
    throw new UploadRequestError(409, 'this upload session has all of its file', {
      code: 'session_closed',
      offset: row.size,
    });
  }
  // An upload to send that went idle stopped holding its space (#1086); to
  // carry on, it must fit again.
  if (row.purpose === 'dcc-send' && dccUploadIsStale(row.updated_at)) {
    assertDccFits(userId, row.size);
  }
  const offset = uploadSessionOffset(id);
  const claimed = typeof offsetHeader === 'string' ? Number(offsetHeader) : NaN;
  if (!Number.isSafeInteger(claimed) || claimed !== offset) {
    throw new UploadRequestError(409, `this upload session is at byte ${offset}`, {
      code: 'offset_mismatch',
      offset,
    });
  }
  const allowed = Math.min(uploadChunkBytes(), row.size - offset);
  if (declaredLength != null && declaredLength > allowed) {
    throw new UploadRequestError(413, `a chunk here may be at most ${allowed} bytes`, {
      code: 'chunk_too_large',
      offset,
    });
  }
  // The space was there when the session opened; other writers may have taken
  // it since.
  if (!hasFreeSpaceFor(UPLOAD_SESSION_DIR, allowed)) {
    throw new UploadRequestError(507, 'not enough free disk space on the server for this file', {
      offset,
    });
  }

  busy.add(id);
  let writeError: NodeJS.ErrnoException | null = null;
  let over = false;
  let cutOff = false;
  try {
    const out = fs.createWriteStream(uploadSessionPath(id), { flags: 'a', mode: 0o600 });
    const closed = new Promise<void>((resolve) => out.once('close', () => resolve()));
    out.on('error', (err: NodeJS.ErrnoException) => {
      // The pipeline hands the client's own failure (a reset, a hang-up) on
      // to the file too; only the file's syscalls failing are ours.
      if (err.syscall === 'open' || err.syscall === 'write' || err.syscall === 'close') {
        writeError = err;
      }
    });
    let seen = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen > allowed) {
          over = true;
          cb(new Error('chunk too large'));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, limit, out);
    } catch {
      // Over the limit (a body without a Content-Length is the only way past
      // the check above), our own disk failing, or the client going away.
      cutOff = !over;
    }
    // ⚠ Not free until the file is closed: a write still in flight would land
    // after the next chunk read the offset, and splice into it.
    await closed;
    if (over) fs.truncateSync(uploadSessionPath(id), offset);
  } finally {
    busy.delete(id);
    touchUploadSession(id);
  }
  const now = uploadSessionOffset(id);
  if (over) {
    throw new UploadRequestError(413, `a chunk here may be at most ${allowed} bytes`, {
      code: 'chunk_too_large',
      offset: now,
    });
  }
  const failed = writeError as NodeJS.ErrnoException | null;
  if (failed) {
    console.warn(`[lurker] upload session ${id}: write failed:`, failed.message);
    throw new UploadRequestError(
      failed.code === 'ENOSPC' ? 507 : 500,
      failed.code === 'ENOSPC'
        ? 'not enough free disk space on the server for this file'
        : 'the server could not write this chunk',
      { offset: now },
    );
  }
  if (cutOff) {
    throw new UploadRequestError(400, 'the chunk was cut off', {
      code: 'interrupted',
      offset: now,
    });
  }
  return { offset: now };
}

/**
 * Hand a whole session's file to `use` and keep what it answers, which is
 * also this call's answer. A session already done answers the same again, so
 * a client that lost the response can ask twice. The file is removed once
 * used; the row stays, done, until the sweep. A session short of its size is
 * refused with the offset, and stays open.
 */
export async function finishUploadSession(
  userId: number,
  id: string,
  use: (row: UploadSessionRow, filePath: string) => Promise<UploadSessionResult>,
): Promise<UploadSessionResult> {
  const row = requireUploadSession(userId, id);
  const now = standing(row);
  if (now.state === 'done') return now.result!;
  if (now.state === 'processing' || busy.has(id)) {
    throw new UploadRequestError(409, 'this upload session is busy with another request', {
      code: now.state === 'processing' ? 'processing' : 'session_busy',
      offset: now.state === 'processing' ? row.size : uploadSessionOffset(id),
    });
  }
  const offset = uploadSessionOffset(id);
  if (offset !== row.size) {
    throw new UploadRequestError(409, `this upload session has ${offset} of ${row.size} bytes`, {
      code: 'incomplete',
      offset,
    });
  }
  // Checked again here, not only at create: a restriction that landed while
  // the chunks were in flight must still keep the assembled file off the
  // uploader.
  refuseIfUploadsRestricted(userId, row.purpose);
  busy.add(id);
  let result: UploadSessionResult = {
    status: 500,
    body: { error: 'the server failed while handling this file' },
  };
  try {
    markUploadSessionProcessing(id);
    result = await use(row, uploadSessionPath(id));
    return result;
  } finally {
    try {
      // A throw from `use` keeps the 500 above, so a client asking later
      // hears the same as the one whose request failed.
      markUploadSessionDone(id, result);
    } catch (err) {
      // Left 'processing' with nothing working on it, it reads as STRANDED.
      console.warn(`[lurker] upload session ${id}: could not record its answer:`, err);
    } finally {
      // The local upload driver may have renamed the file away already.
      fs.promises.unlink(uploadSessionPath(id)).catch(() => {});
      busy.delete(id);
    }
  }
}

/** Remove the session and its file. */
function endSession(id: string): void {
  deleteUploadSession(id);
  fs.promises.unlink(uploadSessionPath(id)).catch(() => {});
}

/** The caller gives up on a session. Not while a request is working on it:
 *  a complete whose answer never reached the client may still be handing the
 *  file on, and a chunk in flight ends with its connection anyway. The sweep
 *  takes what is left. */
export function abortUploadSession(userId: number, id: string): void {
  const row = requireUploadSession(userId, id);
  if (standing(row).state === 'processing') {
    throw new UploadRequestError(409, 'this upload session is being processed', {
      code: 'processing',
      offset: row.size,
    });
  }
  assertIdle(id);
  endSession(id);
}

/**
 * Remove sessions idle for a day (a done one counts from when it finished),
 * and files under the session dir that no session owns (a session whose
 * account was deleted, a crash between writing the file and the row) once
 * they are as old. Skips a session a request is working on.
 */
export async function sweepUploadSessions(now = Date.now()): Promise<number> {
  const cutoff = now - UPLOAD_SESSION_IDLE_MS;
  let removed = 0;
  for (const id of idleUploadSessionIds(new Date(cutoff).toISOString())) {
    if (busy.has(id)) continue;
    endSession(id);
    removed++;
  }
  let names: string[];
  try {
    names = await fs.promises.readdir(UPLOAD_SESSION_DIR);
  } catch {
    names = [];
  }
  const owned = allUploadSessionIds();
  for (const name of names) {
    if (owned.has(name) || busy.has(name)) continue;
    const full = path.join(UPLOAD_SESSION_DIR, name);
    try {
      if ((await fs.promises.stat(full)).mtimeMs < cutoff) {
        await fs.promises.unlink(full);
        removed++;
      }
    } catch {
      // gone already
    }
  }
  if (removed > 0) console.log(`[lurker] swept ${removed} abandoned upload session(s)`);
  return removed;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Sweep now and every hour after. */
export function startUploadSessionSweeper(): void {
  if (sweepTimer) return;
  const run = () =>
    void sweepUploadSessions().catch((err: unknown) => {
      console.warn('[lurker] upload session sweep failed:', (err as Error).message);
    });
  run();
  sweepTimer = setInterval(run, 60 * 60 * 1000);
  sweepTimer.unref();
}

export function stopUploadSessionSweeper(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
