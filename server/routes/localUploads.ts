// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Public, UNAUTHENTICATED route that serves files written by the `local` upload
// driver. The URL is pasted into IRC and opened by anyone — possibly with no
// Lurker account — exactly like an x0/catbox link, so it must not require auth;
// files are protected only by their non-guessable key.
//
// This handler is the real security boundary for local hosting (design §6). We
// copy The Lounge's serve-time recipe but set EVERY header in this handler (not
// via middleware ordering, which a wiring change could silently drop):
//   - sniff the MIME from magic bytes; NEVER trust a stored/claimed content-type
//   - positive INLINE allowlist (images/audio/video/text-plain) → everything
//     else is forced to download, which auto-neutralizes SVG/HTML/JS
//   - X-Content-Type-Options: nosniff backstops the text/plain fallback so a
//     browser won't sniff-and-execute
//   - Content-Security-Policy: default-src 'none'; sandbox on every response
//   - the key is regex-validated and the resolved path asserted to stay inside
//     the storage root → path traversal is impossible by construction

import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import { fileTypeFromBuffer } from 'file-type';
import { isUtf8, trimPartialUtf8 } from '../utils/utf8.js';
import { resolveDiskPath } from '../services/uploadProviders/local.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

// The only key shape the `local` driver mints in P1: {12 hex}.{ext}. (The
// preserve-original-filename shape {random}/{name}.{ext} arrives with #517 and
// will extend this.) Anything else is rejected before touching the filesystem.
const KEY_RE = /^[0-9a-f]{12}\.[a-z0-9]{1,16}$/;

// MIME types safe to render inline. Deliberately excludes SVG/HTML/XML — those
// fall through to forced download. Includes an audio/video set that's harmless
// now (P1 only produces images + text) and ready when binary types land (P4).
const INLINE_MIME = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/flac',
  'video/mp4',
  'video/ogg',
  'video/webm',
  // The media the upload route accepts (#515). quicktime/m4v/m4a weren't here
  // because nothing could produce them; now they can, and a shared clip should play
  // when you click it rather than land in Downloads.
  'video/quicktime',
  'video/x-m4v',
  'audio/x-m4a',
  'audio/mp4',
]);

// file-type recommends >= 4100 bytes to recognize every supported signature.
const SNIFF_BYTES = 4100;

// Read the first SNIFF_BYTES of a file for magic-byte detection. subarray to the
// bytes actually read so a short file's zero-padding never reaches the sniff (a
// subtlety The Lounge's equivalent misses — it isUtf8-checks the padded buffer).
async function sniffHead(fullPath: string): Promise<Buffer> {
  const fd = await fs.promises.open(fullPath, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fd.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

router.get(
  '/:key',
  asyncHandler(async (req: Request, res: Response) => {
    const key = String(req.params.key);
    if (!KEY_RE.test(key)) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    let fullPath: string;
    try {
      fullPath = resolveDiskPath(key);
    } catch {
      res.status(404).json({ error: 'not found' });
      return;
    }

    // Sniff the served type from the file's own bytes — never a stored or claimed
    // content-type. A missing file (raced delete, bad key) throws here → 404.
    let head: Buffer;
    try {
      head = await sniffHead(fullPath);
    } catch {
      res.status(404).json({ error: 'not found' });
      return;
    }

    // Recognized-and-inline → inline; recognized-but-not-inline (pdf/zip/svg/...)
    // → download; unrecognized-but-textual → text/plain; else opaque → download.
    const ft = await fileTypeFromBuffer(head);
    let mime: string;
    let inline: boolean;
    if (ft && INLINE_MIME.has(ft.mime)) {
      mime = ft.mime;
      inline = true;
    } else if (ft) {
      mime = ft.mime;
      inline = false;
    } else if (isUtf8(trimPartialUtf8(head))) {
      mime = 'text/plain; charset=utf-8';
      inline = true;
    } else {
      mime = 'application/octet-stream';
      inline = false;
    }

    // Security headers are set HERE, in the handler (not via middleware ordering
    // that a wiring change could silently drop). Byte delivery then goes to
    // res.sendFile, which adds Range/ETag/Last-Modified + conditional 304s and
    // honors our pre-set Content-Type (send skips its extension guess when a
    // Content-Type is already present — so the sniffed type always wins).
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // The random key already carries a safe extension; use it as the download name.
    res.setHeader('Content-Disposition', inline ? 'inline' : `attachment; filename="${key}"`);

    res.sendFile(fullPath, { maxAge: '365d', immutable: true }, (err) => {
      // A read error before the response is flushed → 404; after, nothing to do.
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  }),
);

export default router;
