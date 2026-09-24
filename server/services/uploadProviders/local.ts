// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The `local` driver — writes upload bytes to the server's own disk and serves
// them back over the public GET /uploads/:key route (routes/localUploads.ts).
// Self-host only: hosted cells are ephemeral (Litestream'd SQLite, no durable
// blob disk), so this driver is never offered on the fleet.
//
// This is the one driver where `storesRemotely` is false: upload() returns a
// RELATIVE url (/uploads/<key>) plus the on-disk `ref`; the upload route
// absolutizes it against PUBLIC_BASE_URL (or the request origin) so the link is
// clickable from IRC. The real security boundary is SERVE-time, not here — see
// routes/localUploads.ts for the sniff / disposition / header recipe.
//
// `public_base_url` puts the links on another origin (#983): a files host the
// operator's reverse proxy points at this instance's /uploads/. The link is then
// absolute already and nothing else moves: PUBLIC_BASE_URL still names the app,
// the OAuth issuer and the soju.im/FILEHOST endpoint, the last of which a client
// only sends its bouncer credentials to on the bouncer's own host.
//
// Storage location is instance-wide (LOCAL_UPLOADS_DIR env, else <data-dir>/
// uploads), resolved identically by this driver and the serving route so the key
// alone locates the file — no per-config lookup on the hot serve path. Every
// configSchema field is optional, so the seeded row still works zero-config.

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

export const configSchema: ConfigField[] = [
  {
    key: 'public_base_url',
    label: 'Public base URL',
    type: 'string',
    required: false,
    default: '',
    description:
      'Serve upload links from another host, e.g. https://files.example.com. Your reverse proxy must pass /uploads/ on that host to Lurker. Blank = this server’s own address.',
  },
];

const BAD_PUBLIC_BASE =
  'Public base URL must be an https address with nothing after the host, e.g. https://files.example.com';

/** The public_base_url origin, '' when unset, or null when it can't be used. An
 *  https origin and nothing more: links go out as <origin>/uploads/<key>, the
 *  path the files host's proxy passes to us, and an http link would be mixed
 *  content in the web client. The link is built from the parsed origin, never the
 *  typed text, and href is compared because it keeps what the parsed fields drop
 *  (a bare `?` or `#`). */
function publicBase(value: string | undefined): string | null {
  const raw = (value || '').trim();
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' && url.href === `${url.origin}/` ? url.origin : null;
}

/** Refuse an unusable public_base_url when it's saved, not on the next upload. */
export function validateConfig(values: Record<string, string>): string | null {
  return publicBase(values.public_base_url) === null ? BAD_PUBLIC_BASE : null;
}

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
  config: Record<string, string>,
): Promise<UploadResult> {
  // validateConfig refuses a bad value on save, so this is only a row written some
  // other way. It's the server's config, not the uploader's, hence PROVIDER_ERROR.
  const base = publicBase(config.public_base_url);
  if (base === null) {
    throw Object.assign(new Error(BAD_PUBLIC_BASE), { code: 'PROVIDER_ERROR' });
  }
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
  return { url: `${base}/uploads/${key}`, ref: key, bytes };
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
