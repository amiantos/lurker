// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The hosted backend (CP #63). Bytes go to the operator-run dropper service —
// POST /api/previews with the cell-computed key — which writes them under the
// fleet bucket's `previews/` prefix, and browsers read them DIRECTLY from the
// CDN in front of that bucket. The cell holds an upload key and nothing else:
// no bucket credentials, no delete capability, by design. The staging, ceiling
// and bounded-read machinery is shared with the s3 backend (./remoteWrite.ts,
// `readRemote`); this module's own parts are the multipart POST and the CDN GET.
//
// ⚠ The key is the SAME `byteCacheKey` digest every cell computes for a URL, so
// the cache is shared fleet-wide: cell B re-storing what cell A already stored
// is an idempotent overwrite of the same object, not a conflict.
//
// ⚠⚠ Everything the s3 module's header says about WHAT A PUBLIC OBJECT CAN AND
// CANNOT CARRY applies verbatim here — same bucket, same CDN, same three
// replayable headers. The dropper sets Content-Type, Content-Disposition and
// Cache-Control on the object at store time; nosniff and the CSP sandbox are
// not expressible, and the bound on that is the dropper's own image-only,
// signature-verified allowlist.

import { fileSource } from '../uploadProviders/source.js';
import { postMultipart, isOk, jsonBody, type StreamPart } from '../uploadProviders/multipart.js';
import { USER_AGENT } from '../../utils/userAgent.js';
import { warnOnce } from './inflight.js';
import { openStagedRemoteWrite, type RemoteWriter } from './remoteWrite.js';
import { readRemote, type S3Read } from './s3.js';
import type { DropperCacheConfig } from './config.js';

/** Where a reader is sent. Public by construction — that is the point of the
 *  mode. `publicBaseUrl` already contains the dropper's key prefix, and the key
 *  is a hex digest, so no joining logic and no percent-encoding is needed. */
export function publicDropperUrl(cfg: DropperCacheConfig, key: string): string {
  return `${cfg.publicBaseUrl}/${key}`;
}

/**
 * Read one object back through the CDN.
 *
 * ⚠ NOT the common path, same as the s3 backend's read: once an object is
 * stored, the descriptor mints its public URL and clients fetch it without
 * touching the cell. This exists for a client holding a descriptor minted
 * BEFORE the store landed — serve them, and on a genuine 404 repair the row
 * that said the object was there. Only a genuine 404 may do that; every other
 * failure is a miss (`readRemote` draws that line).
 *
 * ⚠ `accept-encoding: identity`, unlike the s3 read, because this GET goes
 * through a CDN rather than a bucket API. An edge that compressed the response
 * would make `readRemote`'s Content-Length bound test the WIRE size while the
 * decompressed body inflates past it in the heap — and the inflated length
 * would no longer equal the index row's recorded size, so every proxy read of a
 * perfectly good row would be treated as corrupt and forgotten. Identity makes
 * the declared length the body length again.
 */
export async function readDropper(
  cfg: DropperCacheConfig,
  key: string,
  maxBytes: number,
): Promise<S3Read> {
  const url = publicDropperUrl(cfg, key);
  // ⚠⚠ ASKED WITH A HEAD FIRST, and a GET is sent only for an object the HEAD found.
  // This read is the cold probe as well (`lookup` on an index miss), so for every new
  // image it runs BEFORE the first store and its answer is a 404. A CDN caches the 404
  // to a GET: cdn.lurker.chat kept one for 3 minutes, ignored the query string in its
  // cache key, and stamped it `max-age=14400` for the client. The store then landed, the
  // descriptor minted this same URL, and a reader arriving inside those minutes was
  // handed our own probe's 404 and held it for four hours, with no request reaching the
  // cell to notice. Measured on the same edge: a HEAD for a missing key is answered
  // uncached and leaves nothing behind for the GET that follows.
  // ⚠ Anything but a 2xx or a 404 is an error, not a reason to try the GET anyway: the
  // GET is the request that can poison the edge, and a miss here is only the proxy path.
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      headers: { 'accept-encoding': 'identity' },
      signal: AbortSignal.timeout(30_000),
    });
    if (head.status === 404) return { kind: 'missing' };
    if (!head.ok) return { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
  return readRemote(url, { 'accept-encoding': 'identity' }, maxBytes);
}

/**
 * Begin storing an object whose bytes are still arriving. The staging, the
 * in-flight ceiling and the always-unlink discipline are `openStagedRemoteWrite`'s;
 * this backend's own part is the Bearer-keyed multipart POST — the same protocol
 * the upload driver speaks, down to the User-Agent, so fleet logs can attribute
 * the traffic.
 */
export async function openDropperWrite(
  cfg: DropperCacheConfig,
  key: string,
): Promise<RemoteWriter | null> {
  return openStagedRemoteWrite(
    cfg.stagingDir,
    key,
    'dropper',
    async (stagedPath, size, contentType) => {
      const source = fileSource(stagedPath, size);
      const parts: StreamPart[] = [
        // ⚠ The text part goes BEFORE the file part, so the dropper's multipart
        // parser has the key in req.body by the time the file lands — the same
        // ordering rule the upload driver documents.
        { name: 'key', value: key },
        { name: 'file', filename: key, contentType, source },
      ];
      // 60 s default timeout from postMultipart, same bound as the s3 PUT.
      const resp = await postMultipart(`${cfg.url}/api/previews`, parts, {
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'User-Agent': USER_AGENT },
      });
      if (!isOk(resp)) {
        warnOnce(`dropper refused a store: ${resp.status} ${resp.text.slice(0, 200)}`);
        return false;
      }
      // ⚠⚠ The dropper's answer carries the ONE fact the cell otherwise takes on
      // faith: the public URL the object actually lives at. The cell mints its
      // own URLs as a pure function of config — that is the design — so a layout
      // disagreement (a KEY_PREFIX on the dropper, a wrong PUBLIC_BASE_URL here)
      // would mean every store "succeeds" while every minted URL 404s, with no
      // request ever reaching the cell to notice. Refusing to record the row
      // keeps the proxy fallback serving readers and turns silent fleet-wide
      // blank images into one warning a minute.
      const body = jsonBody(resp) as { url?: unknown } | null;
      const expected = publicDropperUrl(cfg, key);
      if (!body || body.url !== expected) {
        warnOnce(
          `dropper stored at "${body && typeof body.url === 'string' ? body.url : '<no url>'}" ` +
            `but this cell would mint "${expected}" — URL layout mismatch, not recording the store.`,
        );
        return false;
      }
      return true;
    },
  );
}
