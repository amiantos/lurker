// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What a driver is handed to upload. Two shapes, one interface:
//
//   file   — bytes sitting in a temp file (multer's diskStorage). This is the
//            passthrough path: text and (with #515) media, where the original
//            bytes go out untouched and may be hundreds of megabytes.
//   buffer — bytes we produced in memory. This is the image path: the pipeline's
//            optimized output is small and bounded (resized + re-encoded), so
//            round-tripping it through a temp file would be pointless I/O.
//
// The point of the union is that the branch lives HERE, not in seven drivers.
// Every driver takes an UploadSource and calls streamOf/sizeOf/hashOf/moveTo; no
// driver knows or cares which shape it got.
//
// ⚠ Why any of this exists — measured 2026-07-12 on the production runtime
// (Linux, node 22), 300 MB upload, live `arrayBuffers` sampled after a forced GC:
//
//   node:http + pipeline .............   7.6 MB live  (0.03x)
//   fetch, streamed multipart body ...   301 MB live  (1.0x)
//   fetch, openAsBlob in FormData ....   301 MB live  (1.0x)
//   fetch, Blob([Uint8Array(buf)]) ...  1501 MB live  (5.0x)   <- what we shipped
//
// **undici does not propagate backpressure into a request body.** It drains the
// source into memory no matter how the body is supplied — Blob, file-backed Blob,
// ReadableStream, or a hand-built multipart stream with an exact Content-Length.
// Only node's own http/https + stream.pipeline holds constant memory. That is why
// the drivers post through multipart.ts instead of fetch(), and why `fetch` must
// not creep back into an upload path. (It's fine for small bodies: delete calls,
// moderation reports, response reads.)

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export type UploadSource =
  | { kind: 'buffer'; data: Buffer }
  | { kind: 'file'; path: string; size: number };

export function bufferSource(data: Buffer): UploadSource {
  return { kind: 'buffer', data };
}

export function fileSource(path: string, size: number): UploadSource {
  return { kind: 'file', path, size };
}

export function sizeOf(source: UploadSource): number {
  return source.kind === 'buffer' ? source.data.length : source.size;
}

/** A fresh Readable over the bytes. Fresh each call: a retry needs to re-read
 *  from the start, and a consumed stream can't be rewound. */
export function streamOf(source: UploadSource): Readable {
  return source.kind === 'buffer' ? Readable.from([source.data]) : fs.createReadStream(source.path);
}

/** Hex sha256 of the bytes. Streamed, so hashing a 200 MB file costs one pass and
 *  no memory — s3's SigV4 needs the payload hash before it can sign the request,
 *  which is why the file gets read twice (hash, then send). */
export async function hashOf(source: UploadSource): Promise<string> {
  if (source.kind === 'buffer') {
    return createHash('sha256').update(source.data).digest('hex');
  }
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(source.path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** Put the bytes at `dest`, replacing whatever is there. A file source is renamed
 *  (zero copies — the common case for `local`, where multer's temp file and the
 *  storage dir are on the same filesystem); a buffer source is written. Falls back
 *  to a copy when rename crosses a device boundary (EXDEV — e.g. LOCAL_UPLOADS_DIR
 *  on a different mount than the data dir). */
export async function moveTo(source: UploadSource, dest: string): Promise<void> {
  if (source.kind === 'buffer') {
    await fs.promises.writeFile(dest, source.data, { mode: 0o644 });
    return;
  }
  try {
    await fs.promises.rename(source.path, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.promises.copyFile(source.path, dest);
    await fs.promises.unlink(source.path).catch(() => {});
  }
  await fs.promises.chmod(dest, 0o644).catch(() => {});
}
