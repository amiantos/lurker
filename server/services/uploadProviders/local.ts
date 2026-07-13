// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The `local` driver — writes upload bytes to the server's own disk and serves
// them back over the public GET /uploads/local/:key route (routes/localUploads.ts).
// Self-host only: hosted cells are ephemeral (Litestream'd SQLite, no durable
// blob disk), so this driver is never offered on the fleet.
//
// This is the one driver where `storesRemotely` is false: upload() returns a
// RELATIVE url (/uploads/local/<key>) plus the on-disk `ref`; the upload route
// absolutizes it against PUBLIC_BASE_URL (or the request origin) so the link is
// clickable from IRC. The real security boundary is SERVE-time, not here — see
// routes/localUploads.ts for the sniff / disposition / header recipe.
//
// Storage location is instance-wide (LOCAL_UPLOADS_DIR env, else <data-dir>/
// uploads), resolved identically by this driver and the serving route so the key
// alone locates the file — no per-config lookup on the hot serve path. Per-
// uploader storage dirs can come later (P3 admin UI) via a configSchema field;
// keeping the P1 schema empty means the seeded row works zero-config.

import fs from 'fs';
import path from 'path';
import { resolveDataDir } from '../../utils/dataDir.js';
import { buildObjectKey, randomId } from './objectKey.js';
import { moveTo, sizeOf, type UploadSource } from './source.js';
import type { ConfigField, DriverCapabilities, UploadMeta, UploadResult } from './types.js';

export const driver = 'local';
export const label = 'Local disk';

export const capabilities: DriverCapabilities = {
  // We serve the bytes ourselves; the upload route builds the absolute URL.
  storesRemotely: false,
  supportsDelete: true,
  mintsKeys: true,
  acceptsContentClasses: ['image', 'text', 'media'],
  selfHostOnly: true,
};

// Empty in P1 (zero-config, like x0). Storage dir + public base URL come from env
// / request derivation; per-uploader fields arrive with the P3 admin UI.
export const configSchema: ConfigField[] = [];

/** The single instance-wide storage root. Both the driver and the serving route
 *  call this, so the stored key is all that's needed to locate a file. Defaults
 *  to <data-dir>/uploads (beside the SQLite DB) so it survives container rebuilds
 *  on a mounted volume; LOCAL_UPLOADS_DIR overrides it. */
export function resolveStorageDir(): string {
  const fromEnv = (process.env.LOCAL_UPLOADS_DIR || '').trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(resolveDataDir(), 'uploads');
}

/** Map a storage key to its on-disk path, refusing anything that would escape the
 *  storage root. Files are sharded into 256 subdirs by the first two chars of the
 *  key so no single directory accumulates every upload (filesystems + tooling —
 *  ls/tar/backups — degrade on huge flat dirs; The Lounge shards the same way).
 *  The key is regex-validated by callers, so slice(0, 2) is a safe hex pair; the
 *  containment assert is defense in depth on top of that. */
export function resolveDiskPath(key: string, storageDir = resolveStorageDir()): string {
  const root = path.resolve(storageDir);
  const full = path.resolve(root, key.slice(0, 2), key);
  if (!full.startsWith(root + path.sep)) {
    throw Object.assign(new Error('unsafe upload key'), { code: 'PROVIDER_ERROR' });
  }
  return full;
}

export async function upload(
  source: UploadSource,
  { filename }: UploadMeta,
  _config: Record<string, string>,
): Promise<UploadResult> {
  const storageDir = resolveStorageDir();
  // Extension from the (pipeline-produced) filename; buildObjectKey re-sanitizes
  // it, so a hostile value can't escape the key.
  const ext = filename.split('.').pop() || 'bin';
  const key = buildObjectKey({ ext });
  const full = resolveDiskPath(key, storageDir);
  const bytes = sizeOf(source);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  // Land the bytes at a temp sibling, then rename into place, so a crash mid-write
  // never leaves a half-written file at the served key. moveTo does the right
  // thing for either source shape: a passthrough upload is already a file on disk
  // (multer's temp), so it's a rename — the bytes never enter the heap at all;
  // an optimized image is a small buffer, so it's a write.
  const tmp = `${full}.tmp-${randomId()}`;
  try {
    await moveTo(source, tmp);
    await fs.promises.rename(tmp, full);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw Object.assign(new Error(`local write failed: ${(err as Error).message}`), {
      code: 'PROVIDER_ERROR',
    });
  }
  return { url: `/uploads/local/${key}`, ref: key, bytes };
}

/** Orphan reap: unlink the on-disk file when its history row is deleted. Missing
 *  file is not an error (already gone / never written). */
async function del(ref: string, _config: Record<string, string>): Promise<void> {
  const full = resolveDiskPath(ref);
  try {
    await fs.promises.unlink(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export { del as delete };
