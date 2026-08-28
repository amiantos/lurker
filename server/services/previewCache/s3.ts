// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The bucket backend. Objects are PUT with SigV4 and then read DIRECTLY by
// browsers from the bucket's public base URL — the descriptor hands out that URL
// instead of a proxy path once an object is known to exist, so the cell ships
// zero bytes for a cached image. That decision is made in ./publicUrl.ts
// (`publicByteUrl`), which dispatches to this module's `publicUrl` formatter; it
// lives in a leaf module rather than ./index.ts because the resolver has to call
// it, and ./index.ts imports the resolver.
//
// ⚠ Reuses the UPLOADER's `signObjectRequest`, `hashOf` and `putSource` rather
// than the provider interface, and that is the shape #681 asks for: the interface
// fits neither side of this problem. `dropper` (the hosted driver) declares
// `mintsKeys: false`, and a cache entry has to be addressable by a key derived
// from its URL; `local` and `s3` are both `selfHostOnly`, so the abstraction is
// never offered where the hosted case needs it. The SIGNING and the TRANSPORT are
// the reusable parts, and both are already exported.
//
// ⚠⚠ WHAT A PUBLIC OBJECT CAN AND CANNOT CARRY. The proxy sets six response
// headers on every byte answer (`applyMediaHeaders`). An S3 object can only store
// and replay a fixed few — Content-Type, Content-Disposition, Cache-Control — so
// three of them are simply not expressible here:
//
//   stored:      Content-Type, Content-Disposition: inline, Cache-Control
//   NOT stored:  X-Content-Type-Options: nosniff
//                Content-Security-Policy: default-src 'none'; sandbox
//                Cross-Origin-Resource-Policy
//
// This is a property of object storage, not of this code, and it is NOT fixed by
// serving via a redirect either — headers on a 302 do not apply to its target.
// The only design where all six survive is proxying the bytes, which is what
// `local` does and what this mode exists to avoid.
//
// Taken one at a time, because they are NOT equally missed:
//
//   - CORP costs NOTHING, and calling it a concession was wrong. Its job is
//     keeping a resource out of a hostile page's process (the Spectre-era
//     COOP/COEP family); these objects are deliberately public, so there is
//     nothing to isolate. And the proxy's own value, `same-origin`, would BREAK a
//     CDN object — a page on the app origin embedding one is cross-origin by
//     definition. The only workable value on a separate host is `cross-origin`,
//     which is the permissive default. We could not have used it if we could set
//     it.
//   - `nosniff` is a SMALL loss. It matters most when the type is absent or
//     generic (`text/plain`, `application/octet-stream`); a concrete `image/*` is
//     stored here, and browsers do not sniff a document out of a declared image
//     type on a top-level navigation. For an `<img>` load it is irrelevant
//     either way — the decoder goes by magic bytes and a non-image just fails.
//   - The CSP `sandbox` is the REAL loss of the three, and only for someone
//     navigating DIRECTLY to an object URL: it forces an opaque origin with no
//     script execution, so bytes a browser did decide to treat as a document
//     stay inert. CSP on a subresource is otherwise ignored.
//
// ⚠⚠ AND THE THING THAT ACTUALLY BOUNDS THIS IS NOT A HEADER. All three only
// matter if non-image bytes can be stored under an image content type — and today
// they can: `kindForContentType` tests the DECLARED type
// (`contentType.startsWith('image/')`, with `image/svg+xml` refused) and nothing
// on the byte path inspects the body. An origin under an attacker's control
// serves `Content-Type: image/png` with an HTML body, and we cache it verbatim;
// the URL is minted to their own client, so they can hand it to anyone.
//
// ⚠ An earlier version of this comment claimed the stored `Content-Type` was
// "set from the type we validated rather than from anything the origin asserted
// unchecked". That was not true — the allowlist validates the origin's CLAIM, not
// the bytes — and it is the sort of false reassurance that stops the next person
// looking. Validating the bytes at store time removes the whole class for every
// backend at once, which is the right altitude and is tracked separately; until
// then this is a real, if narrow, residual: content on the CDN origin rather than
// the app origin, and Lurker's session cookie is host-only, so it is not a
// session-theft path.
//
// An operator who wants the other two can add them at the CDN edge (Cloudflare
// Transform Rules and equivalents do this), which is a deployment choice we can
// document but cannot enforce from here.

import { fileSource, hashOf } from '../uploadProviders/source.js';
import { putSource } from '../uploadProviders/multipart.js';
import { signObjectRequest } from '../uploadProviders/s3.js';
import { warnOnce } from './inflight.js';
import { openStagedRemoteWrite } from './remoteWrite.js';
import type { S3CacheConfig } from './config.js';

// The store bounds and the warn throttle moved to ./inflight.ts when the dropper
// backend arrived (they are per-process, not per-backend). Re-exported here so
// the s3 route suite — which imports its seams from this module — is untouched.
export { storesInFlightForTests, resetWarnThrottleForTests } from './inflight.js';

/**
 * What a CACHED object advertises to the browsers that read it directly.
 *
 * ⚠ Not the uploader's year of `immutable`, and not `public` either. A day
 * matches what the proxy has always sent for the same bytes, so turning this mode
 * on does not change how long a client holds an image. Bounded freshness also
 * means deleting an object actually un-serves it within a day — with a year at
 * the edge, a takedown would delete the origin copy and change nothing.
 */
const OBJECT_CACHE_CONTROL = 'public, max-age=86400';

/** No filename: it would come from a URL someone else controls. Same value the
 *  proxy sends, and one of the three that object storage will actually replay. */
const OBJECT_CONTENT_DISPOSITION = 'inline';

/**
 * Let go of a response we are not going to read.
 *
 * ⚠⚠ CANCEL, never `res.text()`. Undici keeps the connection alive for an unread
 * body, so it does have to be dealt with — but reading it to discard it buffers
 * the whole thing, which is unbounded by protocol on an error path and is
 * precisely backwards in the oversize branch, where the guard would announce that
 * a body is too large to hold and then hold it. It is also not merely wasteful: a
 * bucket that sends headers and then stalls makes `text()` block for the full
 * request timeout, inside a `mediaPool` slot, for bytes nobody wants. Cancelling
 * releases the socket without reading a byte. (Copilot.)
 */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already consumed, already errored, or no body at all — the connection is
    // going away regardless, and this is cleanup on a path that is already
    // returning a failure.
  }
}

/** Where a reader is sent. Public by construction — that is the point of the mode. */
export function publicUrl(cfg: S3CacheConfig, key: string): string {
  return `${cfg.publicBaseUrl}/${objectKey(cfg, key)}`;
}

/**
 * ⚠ The prefix is already sanitised and slash-trimmed by `resolveCacheConfig`, and
 * `key` is a hex digest, so the result needs no percent-encoding — which is what
 * lets the signed URL and the public URL agree byte for byte and sidesteps the
 * classic SigV4 encoding mismatch.
 */
export function objectKey(cfg: S3CacheConfig, key: string): string {
  return cfg.prefix ? `${cfg.prefix}/${key}` : key;
}

/**
 * ⚠⚠ Distinguishes GONE from BROKEN, exactly as `local`'s read does, and for the
 * same reason: only a genuinely absent object may forget its index row. A 403, a
 * timeout or a DNS failure is a miss and nothing more — treating those as "the
 * object is gone" would delete the index while the bytes sit in the bucket,
 * unnameable and unbilled-for by anything that could clean them up.
 */
export type S3Read =
  | {
      kind: 'ok';
      body: Buffer;
      contentType: string;
      /**
       * When the object was written, from `Last-Modified`, in epoch ms — or null
       * when the store did not say.
       *
       * ⚠ Carried because it is the only HONEST age for these bytes. The index row's
       * `created_at` is this cell's record of its own store, and the bucket is shared:
       * a row can be absent (another cell wrote the object) or long expired while the
       * object itself was rewritten yesterday. `lookup` needs the object's age, not
       * ours, before it will serve one the index cannot vouch for.
       */
      storedAt: number | null;
    }
  | { kind: 'missing' }
  | { kind: 'error' };

/**
 * One bounded GET, shared by every remote backend. The caller supplies the URL
 * and headers (SigV4 for the bucket, plain for the CDN); everything about how a
 * response may be trusted lives HERE, once, because the two subtlest guards in
 * this feature are in it and a hand-synced copy is how one of them quietly
 * stops applying.
 *
 * ⚠ `fetch` rather than `node:http` deliberately, unlike the write path. The
 * memory hazard measured in #543 is undici buffering REQUEST bodies; a response
 * body is read once into a bounded buffer here, the same shape as `local`'s
 * `readFile`, and bounded by the same `mediaPool`.
 */
export async function readRemote(
  url: string,
  headers: Record<string, string>,
  maxBytes: number,
): Promise<S3Read> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) {
      await discard(res);
      return { kind: 'missing' };
    }
    if (!res.ok) {
      await discard(res);
      return { kind: 'error' };
    }
    // ⚠⚠ Bounded before reading, not after — and an ABSENT length is declined, not
    // waved through. `headers.get()` answers null when the header is missing and
    // `Number(null)` is 0, which is finite and under any cap, so a `Number.isFinite`
    // test alone passes exactly the responses it cannot bound: a chunked reply from
    // a caching proxy in front of the bucket, or a large object someone else wrote
    // to that key. `arrayBuffer()` would then pull the whole thing into the heap
    // inside a `mediaPool` slot, which is what this guard exists to stop.
    const raw = res.headers.get('content-length');
    const declared = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(declared) || declared > maxBytes) {
      // ⚠⚠ CANCELLED, not read. `res.text()` here would buffer the very body this
      // branch exists to refuse — the guard would announce the response is too big
      // to hold and then hold it. Worse, against a bucket that sends headers and
      // stalls it blocks for the full 30 s timeout inside a `mediaPool` slot.
      await discard(res);
      return { kind: 'error' };
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) return { kind: 'error' };
    // ⚠ `Date.parse` on an HTTP-date, and NaN is normalised to null rather than left
    // to poison an arithmetic comparison — a bucket that omits the header or sends
    // something unparseable must read as "age unknown", which the caller fails closed on.
    const modified = Date.parse(res.headers.get('last-modified') ?? '');
    return {
      kind: 'ok',
      body,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      storedAt: Number.isFinite(modified) ? modified : null,
    };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * Read one object back through the bucket's API.
 *
 * ⚠ This is NOT the common path, and it is worth knowing why it exists at all.
 * Once an object is stored, the descriptor mints its public URL and clients fetch
 * it without touching the cell. A request arriving at the proxy for a key we have
 * therefore means a client is holding a descriptor minted BEFORE the store landed
 * — so this both serves them without a third-party round trip and, on a 404,
 * repairs the row that told us the object was there.
 */
export async function readS3(cfg: S3CacheConfig, key: string, maxBytes: number): Promise<S3Read> {
  try {
    const signed = signObjectRequest({
      method: 'GET',
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      key: objectKey(cfg, key),
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
    return await readRemote(signed.url, signed.headers, maxBytes);
  } catch {
    return { kind: 'error' };
  }
}

/**
 * Delete one object.
 *
 * ⚠ Reports whether it is actually GONE, the same contract as `removeLocal`, and
 * for the same reason: the caller drops the index row only for what it really
 * removed. S3 DeleteObject is idempotent by protocol — deleting an absent key
 * returns 204 — so there is no 404 carve-out to make here.
 */
export async function removeS3(cfg: S3CacheConfig, key: string): Promise<boolean> {
  try {
    const signed = signObjectRequest({
      method: 'DELETE',
      endpoint: cfg.endpoint,
      bucket: cfg.bucket,
      key: objectKey(cfg, key),
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    });
    const res = await fetch(signed.url, {
      method: 'DELETE',
      headers: signed.headers,
      signal: AbortSignal.timeout(30_000),
    });
    await discard(res);
    return res.ok;
  } catch {
    return false;
  }
}

// The writer shape and the staged-write scaffold live in ./remoteWrite.ts,
// shared with every remote backend; the alias keeps this module's public
// surface (and the route suite that imports from it) unchanged.
export type { RemoteWriter as S3Writer } from './remoteWrite.js';

/**
 * Begin storing an object whose bytes are still arriving. The staging, the
 * in-flight ceiling and the always-unlink discipline are `openStagedRemoteWrite`'s
 * (see ./remoteWrite.ts); this backend's own part is the SigV4 PUT.
 */
export async function openS3Write(
  cfg: S3CacheConfig,
  key: string,
): Promise<import('./remoteWrite.js').RemoteWriter | null> {
  return openStagedRemoteWrite(
    cfg.stagingDir,
    key,
    'bucket',
    async (stagedPath, size, contentType) => {
      const source = fileSource(stagedPath, size);
      // Two streamed passes over a warm temp file — one to hash, one to send —
      // rather than one pass through the heap. Same trade the uploader makes.
      const payloadHash = await hashOf(source);
      const signed = signObjectRequest({
        method: 'PUT',
        endpoint: cfg.endpoint,
        bucket: cfg.bucket,
        key: objectKey(cfg, key),
        payloadHash,
        contentType,
        cacheControl: OBJECT_CACHE_CONTROL,
        contentDisposition: OBJECT_CONTENT_DISPOSITION,
        region: cfg.region,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      });
      // ⚠ `putSource` is node:http with a 60 s default timeout, so a bucket that
      // accepts the connection and never replies cannot pin a staged file
      // forever. The reference used bare `fetch` with no signal at all: one
      // stalled PUT per miss, each holding its payload, in the process running
      // every tenant's IRC connections — an OOM reachable from a config typo.
      const resp = await putSource(signed.url, source, { headers: signed.headers });
      if (resp.status >= 200 && resp.status < 300) return true;
      warnOnce(`bucket refused a store: ${resp.status} ${resp.text.slice(0, 200)}`);
      return false;
    },
  );
}
