// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The preview byte cache, as the route sees it: `lookup` before fetching, `store`
// after. Everything below this line is a backend detail.
//
// ⚠⚠ THE CACHE IS NEVER A FAILURE PATH. Every function here answers "miss" rather
// than throwing, for every cause — misconfiguration, a wiped directory, a locked
// database, a race with eviction. The uncached path is a complete, working feature
// (it is what shipped, and what runs with the cache off), so any doubt resolves to
// using it. A cache that can break the thing it accelerates is worse than no cache.
// ⚠ That was a CLAIM before it was true: `lookup` threw a SQLITE_BUSY straight out
// of the route, past a `try` that did not open for another seventy lines, and 500'd
// an image request that would have succeeded with caching switched off. The guard
// now lives in this module, where the promise is made.
//
// ⚠ IMAGES ONLY, deliberately — and this scope is now enforced upstream rather than
// merely observed here. Video and audio used to be proxied but never cached (they
// are fetched with RANGE requests, so a cached copy would have to answer partial
// reads, and one seek is many requests for one object), which meant the ONE
// mechanism making this feature affordable — store once, then mint a CDN URL —
// covered only the cheap kind. That asymmetry is what exhausted the control
// plane's socket memory on 2026-08-10. Video and audio are no longer relayed at
// all (`proxyableContentType`), so "images only" is no longer a gap: it is the
// whole set of things the proxy serves. See "Link previews & inline media" in
// docs/SELF_HOSTING.md.

import {
  expiredCached,
  foreignCached,
  lookupCached,
  recordCached,
  forget,
} from '../../db/previewCache.js';
import { kindForContentType, MAX_IMAGE_PROXY_BYTES } from '../previewShared.js';
import { imageSignatureOf, SIGNATURE_BYTES } from '../../utils/imageSignature.js';
import { cacheConfig, cacheEnabled, expired, MAX_AGE_MS } from './config.js';
import { evictLocal, objectPath, openLocalWrite, readLocal, removeLocal } from './local.js';
import { openS3Write, readS3, removeS3, type S3Writer } from './s3.js';
import { openDropperWrite, readDropper } from './dropper.js';

export type { CacheConfig, CacheMode } from './config.js';
export { objectPath };
// ⚠ Re-exported rather than defined here. They live in `config.ts` because
// `toDescriptor` needs `publicByteUrl`, and this module imports the resolver for
// `kindForContentType` — so anything the resolver has to reach must sit BELOW that
// import or the two modules form a cycle. Callers still see one surface.
export {
  byteCacheKey,
  posterCacheKey,
  isPosterKey,
  cacheConfig,
  cacheEnabled,
  resetCacheConfigForTests,
} from './config.js';
export { publicByteUrl } from './publicUrl.js';

/**
 * Served from bytes we hold.
 *
 * ⚠ The ONLY hit shape, for every backend, and deliberately so. An earlier `s3`
 * draft added a `redirect` hit and had the route 302 to the CDN — which meant the
 * route grew a second response path that the whole security-header story had to be
 * re-derived for, and which forwarded `Authorization` into the CDN's logs on any
 * client that sets it by hand. Sending a client to the CDN is now a decision made
 * at DESCRIPTOR-MINT time (`publicByteUrl`), where it costs no redirect and no
 * second response shape; by the time a request reaches the proxy, the only useful
 * answer is bytes.
 */
export interface BufferHit {
  kind: 'buffer';
  body: Buffer;
  contentType: string;
}
export type CacheHit = BufferHit;

/** A store in progress. The route feeds it the bytes it is already streaming. */
export interface StoreWriter {
  write(chunk: Buffer): void;
  commit(contentType: string): Promise<boolean>;
  abort(): Promise<void>;
}

/**
 * Drop index rows whose objects are past the age bound. Returns how many went.
 *
 * ⚠ `local` reclaims by PRESSURE (eviction against a size ceiling) and repairs on
 * READ, so its rows are already bounded and this is hygiene. `s3` has neither: no
 * ceiling, and — now that a hit is served from a URL the cell never sees fetched —
 * far fewer reads to repair anything on. Without a sweep its index grows for the
 * life of the instance, and every stale row is one `publicByteUrl` might mint from
 * the moment it passes the bound. This is `sweepExpiredPreviews()`'s job, for the
 * table `link_previews` does not cover.
 *
 * ⚠ Bounded per pass, like eviction, so a long-neglected instance drains over
 * several hours instead of making one tick pay for all of it.
 */
const SWEEP_BATCH = 500;

export async function sweepPreviewCache(): Promise<number> {
  try {
    const cfg = cacheConfig();
    if (cfg.mode === 'off') return 0;

    const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
    let swept = 0;
    for (const entry of expiredCached(cfg.mode, cutoff, SWEEP_BATCH)) {
      // ⚠ Bytes first, row second, and the row only for what actually went — the
      // other order leaves an object nothing remembers. `s3` deliberately does NOT
      // delete: retention there is a bucket lifecycle rule the operator owns, and
      // issuing a DELETE per expired row would be one billed API call each to
      // duplicate work the bucket is already doing.
      if (cfg.mode === 'local' && !(await removeLocal(cfg, entry.key))) continue;
      forget(entry.key);
      swept++;
    }

    // ⚠⚠ Rows from a backend that is no longer configured, which nothing else ever
    // revisits. `lookup` drops a foreign row only when a request asks for that
    // exact key — and after a mode switch nothing does, because the descriptor
    // never mints for a backend that is not current. Left alone they are rows for
    // bytes that are unreachable by construction, kept for the life of the
    // instance.
    //
    // ⚠ The ROW only, never the bytes, and the asymmetry is deliberate: this
    // process holds the configuration for the CURRENT backend and nothing else, so
    // it cannot know where a `local` row's file lived or which bucket an `s3` row's
    // object is in. Guessing a path from the current config would delete whatever
    // happened to sit at that path. Switching modes therefore leaves the old
    // backend's bytes for the operator to remove — one directory, documented in
    // .env.example as safe to delete, or one bucket prefix.
    for (const entry of foreignCached(cfg.mode, SWEEP_BATCH)) {
      forget(entry.key);
      swept++;
    }
    return swept;
  } catch {
    return 0;
  }
}

/**
 * Is this worth caching at all?
 *
 * Exported because the route makes the same judgement twice — once to decide
 * whether to look, once to decide whether to store — and two copies of a predicate
 * is how they drift.
 *
 * ⚠⚠ Asks `kindForContentType`, never `startsWith('image/')`. That allowlist is the
 * one place `image/svg+xml` is refused — "a scripting format wearing a picture's
 * clothes", in the resolver's own words — and a second copy of that rule is
 * precisely how it nearly got served under our origin once before. A `startsWith`
 * test here accepted SVG, and was safe only because `proxyableContentType` happens
 * to run thirty-five lines earlier in the one caller. That is an ordering, not a
 * guarantee.
 */
export function cacheable(
  contentType: string | undefined,
  isRangeRequest: boolean,
  cacheControl?: string,
): boolean {
  if (!cacheEnabled()) return false;
  // ⚠ A range request is passed straight through, never served from cache and never
  // stored. Answering one correctly means honouring an arbitrary byte window, and
  // the only content that asks for ranges is the media this cache excludes anyway.
  // Serving a whole object to a request for bytes 100-200 is a correctness bug.
  if (isRangeRequest) return false;
  if (!originPermitsStoring(cacheControl)) return false;
  return !!contentType && kindForContentType(contentType) === 'image';
}

/**
 * Whether the ORIGIN permits us to keep a copy.
 *
 * ⚠⚠ A 200 carrying real image bytes is not the same as permission to KEEP them, and
 * until this nothing here asked. `opengraph.githubassets.com` answers a card it cannot
 * render with a 200 and a perfectly valid PNG — the dark Octocat placeholder — under
 * `cache-control: public, max-age=0`; a card it DID render comes back `max-age=21600,
 * immutable`. The placeholder passed every guard this module has (real PNG signature,
 * honest Content-Length, cleanly framed) and was then stored and re-served under our own
 * `private, max-age=86400, immutable` for the full seven days, long after GitHub had
 * started rendering the real card. The one thing that distinguished the two was a header
 * we never read.
 *
 * ⚠ Silence is PERMISSION, not prohibition: plenty of image hosts send no Cache-Control
 * at all, and refusing those would turn the cache off for most of the web.
 *
 * ⚠ `no-cache` is refused even though HTTP allows storing it, because what it actually
 * demands is revalidation on every use and this cache does not revalidate — so "store it
 * and never check again" is the one thing it must not mean here. `private` is refused
 * because this IS a shared cache: on hosted, one bucket serving the whole fleet.
 */
function originPermitsStoring(cacheControl: string | undefined): boolean {
  if (!cacheControl) return true;
  const directives = cacheControl
    .toLowerCase()
    .split(',')
    .map((d) => d.trim());
  if (
    directives.includes('no-store') ||
    directives.includes('no-cache') ||
    directives.includes('private')
  ) {
    return false;
  }
  // ⚠ Zero freshness is the placeholder's own tell. Read from BOTH forms, and only an
  // explicit zero — a missing or unparseable max-age says nothing either way, and
  // guessing from it would start refusing perfectly cacheable images.
  return !directives.some((d) => /^(?:s-maxage|max-age)=0+$/.test(d));
}

/**
 * A cached copy, or null. Never throws.
 *
 * ⚠ Repairs the index rather than merely missing. A row whose file has vanished —
 * a wiped volume, a restored backup, a manual `rm` — would otherwise answer "hit"
 * forever, costing a failed read before the origin fetch that was going to happen
 * anyway, because nothing else ever revisits the row.
 *
 * ⚠⚠ The SIZE is checked, not just presence. the writer does not fsync before
 * renaming, so a power loss or a killed container can leave a short file under a
 * row (WAL-durable) claiming the full length. `readFile` then succeeds, nothing
 * throws, and the stump is served with `max-age=86400, immutable` — a permanently
 * broken image every viewer holds for a day. A zero-length Buffer is also truthy,
 * so a presence test does not catch that one either.
 *
 * ⚠⚠ AN ABSENT OR EXPIRED ROW IS NOT PROOF THE BYTES ARE GONE, and treating it as
 * proof is what lurker#776 turned out to be. For the remote backends the object
 * OUTLIVES its row by design: the row is bounded at `MAX_AGE_MS` (7 d) precisely so
 * it is provably shorter-lived than the bucket's lifecycle rule (30 d). Between
 * those two numbers sits an object nothing can name — even though the key that
 * names it is a pure function of the URL we are already holding (`byteCacheKey`).
 * We threw that away and went back to the ORIGIN for a file we already owned.
 *
 * Measured on app.lurker.chat: a GitHub og:image stored 10 Aug, re-fetched and
 * re-uploaded byte-for-byte 18 days later (same ETag, same 48,559 bytes). And when
 * the origin refused that pointless re-fetch — opengraph.githubassets.com
 * rate-limits renders per IP — the card stayed permanently broken with the bytes
 * sitting in the bucket the whole time. A genuine 404 from the backend is the ONLY
 * thing that means gone.
 *
 * ⚠ This is the one place the module's "existence is answered from the index, never
 * by asking the backend" rule is relaxed, and only where the index has already
 * answered "no" — a hot hit still costs no round trip. On a real miss it is an edge
 * 404 rather than an origin render, so it is strictly cheaper than the fetch it
 * replaces. It also makes the fleet-shared bucket shared for READS: a cell that
 * never stored an object can now serve one another cell did.
 *
 * ⚠⚠ A cold hit deliberately does NOT record a row. `recordCached` stamps
 * `created_at` with NOW and the object's real age is unknown, so an object at day 25
 * would get a row expiring at day 32 — past the lifecycle deletion — and
 * `publicByteUrl` would then mint a public URL that 404s for every viewer, with no
 * request reaching us to notice. That is the exact failure the age bound exists to
 * prevent. Serving the bytes needs no row; minting a URL for them does. (The
 * object's true age is in its `Last-Modified`, and carrying that into the row would
 * let minting resume for days 7–30 — the obvious follow-up, once the upsert's
 * `created_at` semantics are settled.)
 */
export async function lookup(key: string): Promise<CacheHit | null> {
  try {
    const cfg = cacheConfig();
    if (cfg.mode === 'off') return null;

    // ⚠ A row from another backend is FORGOTTEN, not merely skipped. Left in place
    // after a mode change it is unreachable and uncounted at once, so its bytes sit
    // on the volume forever with nothing able to name them.
    let entry = lookupCached(key);
    if (entry && entry.backend !== cfg.mode) {
      forget(key);
      entry = null;
    }

    // ⚠ An AGE bound as well as a size one. Eviction is by pressure, so without this
    // an entry at a stable URL that changes underneath it — an avatar, a
    // `latest.png` — is served from disk indefinitely under `max-age=86400,
    // immutable`, long after the metadata row has re-resolved. Before the cache
    // existed the staleness window was a day; unbounded is a regression, not a
    // feature. Matched to the metadata cache's own OK_TTL so the two agree.
    if (entry && expired(entry.createdAt)) {
      // ⚠ `local` is the cell's OWN volume: it runs the eviction, it owns the
      // lifetime, and an expired object is one it should reclaim. There is nothing
      // to verify against — deleting is the whole answer.
      if (cfg.mode === 'local') {
        if (await removeLocal(cfg, key)) forget(key);
        return null;
      }
      // Remote: the row is stale, the OBJECT may not be. Fall through and ask.
      // The row is kept for now — it still carries the size and content type this
      // read is cross-checked against, and only a genuine 404 may drop it.
    }

    // ⚠ No cold path for `local`, deliberately. There the row IS the index for a
    // file this cell wrote and evicts, so an absent row means we dropped it on
    // purpose; resurrecting it would undo an eviction and desync the size ceiling
    // the rows are the accounting for.
    if (!entry && cfg.mode === 'local') return null;

    const read =
      cfg.mode === 'local'
        ? await readLocal(cfg, key)
        : cfg.mode === 's3'
          ? await readS3(cfg, key, MAX_IMAGE_PROXY_BYTES)
          : await readDropper(cfg, key, MAX_IMAGE_PROXY_BYTES);
    // ⚠⚠ Only a GENUINELY MISSING object forgets its row. `readLocal` used to
    // collapse every errno to null, so a transient EMFILE — 24 concurrent reads is
    // within this pool's own budget — or an EACCES after a permissions change
    // deleted the index row while the object stayed on disk. That is an orphan
    // eviction can never count and lookup can never find, in a module whose whole
    // premise is that the index is how we know what exists. Any other error is just
    // a miss. `readS3` draws the same line at a 404: a 403 or a timeout must not be
    // read as "the lifecycle rule took it".
    if (read.kind === 'missing') {
      forget(key);
      return null;
    }
    if (read.kind === 'error') return null;

    if (entry) {
      if (read.body.length !== entry.size) {
        // ⚠ For `local` the row is dropped only if the bad file actually went with it —
        // otherwise we would forget an object that is still on the volume. For `s3` a
        // length disagreement means the key holds bytes we did not put there, so the
        // row is wrong either way; the object is left alone because it is not ours to
        // assume, and the next store re-PUTs and re-records it.
        if (cfg.mode !== 'local' || (await removeLocal(cfg, key))) forget(key);
        return null;
      }
      return { kind: 'buffer', body: read.body, contentType: entry.contentType };
    }

    // A cold hit: no row vouches for these bytes, so they must vouch for
    // themselves. The stored Content-Type is a CLAIM by whatever wrote the key —
    // the same reasoning as the store path's own gate — and with no recorded size
    // to cross-check, the signature is what stands in for it.
    // ⚠ `in` rather than a cast. `readLocal` has no content type to report, and the
    // guard above already makes this branch remote-only — but the compiler cannot
    // see that correlation, and a cast would paper over it rather than state it.
    const declared =
      'contentType' in read && typeof read.contentType === 'string' ? read.contentType : '';
    const contentType = declared.split(';')[0].trim().toLowerCase();
    if (kindForContentType(contentType) !== 'image') return null;
    if (!imageSignatureOf(read.body.subarray(0, SIGNATURE_BYTES))) return null;
    return { kind: 'buffer', body: read.body, contentType };
  } catch {
    return null;
  }
}
/**
 * Outstanding cache DECISIONS — not outstanding writes.
 *
 * ⚠⚠ A test seam, and the distinction is the whole reason it exists. The route
 * deliberately does not await a store: the reader already has their bytes, and a
 * slow disk must not hold the response open. From outside, that makes "nothing was
 * cached" and "the decision has not been reached yet" indistinguishable — so a
 * suite asserting an ABSENCE (a truncated body must not be stored; a video must
 * not be) can pass for the wrong reason and never know.
 *
 * ⚠ An earlier version counted writes in flight and was worse than useless: it
 * resolved instantly whenever no store had *started*, which is precisely the state
 * an absence test is in, and reverting the truncation guard left the suite green.
 */
let pendingDecisions = 0;
let decisionWaiters: Array<() => void> = [];

/** Register a cache decision that has begun. Returns its one-shot settle. */
export function trackPendingStore(): () => void {
  pendingDecisions++;
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    pendingDecisions--;
    if (pendingDecisions > 0) return;
    const waiters = decisionWaiters;
    decisionWaiters = [];
    for (const w of waiters) w();
  };
}

/** Resolves once every begun decision has been reached. Test-only. */
export function whenStoresSettle(): Promise<void> {
  if (pendingDecisions === 0) return Promise.resolve();
  return new Promise((resolve) => decisionWaiters.push(resolve));
}

/**
 * Store bytes we just fetched. Returns whether anything was kept. Never throws.
 *
 * ⚠ The row is written only AFTER the bytes are, and rolled back if the index
 * write fails. An index entry for an object that does not exist is the state this
 * design cannot tolerate quietly.
 */
export async function store(key: string, body: Buffer, contentType: string): Promise<boolean> {
  const writer = await beginStore(key, body.length);
  if (!writer) return false;
  writer.write(body);
  return writer.commit(contentType);
}

/**
 * Begin storing an object whose bytes are still arriving.
 *
 * ⚠ Room is made HERE, before a byte is written, so the ceiling is never crossed
 * and eviction is not gated on the success of the write it exists to enable —
 * which is what made it unreachable on a full volume, the one time it matters.
 * `expected` is the origin's declared length when it gave one, and the transfer
 * cap when it did not: over-reserving by a few megabytes is cheap, and under-
 * reserving is how the ceiling gets crossed.
 *
 * ⚠ An object LARGER than the whole ceiling is refused outright. Without that,
 * `evictLocal` loops toward a total it can never reach, throws away up to a full
 * batch of live entries, and stores the oversized object anyway — so a small
 * ceiling with large images means every single store wipes the cache and the hit
 * rate collapses to nothing.
 */
export async function beginStore(key: string, expected: number): Promise<StoreWriter | null> {
  try {
    const cfg = cacheConfig();
    if (cfg.mode === 'off') return null;

    // ⚠ The ceiling and the eviction pass are `local`'s alone. A bucket has no
    // fixed size to stay under and its retention is a lifecycle rule the cell does
    // not run — deliberately, per LINK_PREVIEWS_CACHE_PLAN.md, which declines to
    // build an abuse ceiling and watches bucket size instead.
    if (cfg.mode === 'local') {
      if (expected > cfg.maxBytes) return null;
      await evictLocal(cfg, expected);
    }

    // ⚠ Adapted to one shape here rather than by widening `LocalWriter`. The two
    // backends genuinely differ: a file has no metadata, so `local` carries the
    // content type in the index row alone, while `s3` must put it ON the object
    // where a browser reading the object directly will see it.
    let writer: S3Writer;
    if (cfg.mode === 'local') {
      const local = await openLocalWrite(cfg, key);
      if (!local) return null;
      writer = {
        write: (chunk) => local.write(chunk),
        commit: () => local.commit(),
        abort: () => local.abort(),
      };
    } else {
      const remote =
        cfg.mode === 's3' ? await openS3Write(cfg, key) : await openDropperWrite(cfg, key);
      if (!remote) return null;
      writer = remote;
    }

    let size = 0;
    // ⚠ The first bytes are kept so `commit` can ask what they actually ARE. Only
    // `SIGNATURE_BYTES` of them: a signature is a fixed-offset fact, so there is
    // nothing to gain from holding more, and this runs per store on a path whose
    // whole design is to keep bytes out of the heap.
    const head: Buffer[] = [];
    let headLen = 0;
    return {
      write(chunk: Buffer): void {
        if (headLen < SIGNATURE_BYTES) {
          // ⚠⚠ COPIED, not a view. `subarray` shares the chunk's backing
          // ArrayBuffer, so keeping a 16-byte view of a 64 KB network chunk pins
          // the whole 64 KB until `commit` — which is after the entire body has
          // streamed. In a module whose stated purpose is keeping bytes out of the
          // heap, that is the bug wearing the fix's clothes: bounded by the store
          // ceilings, but retained for the full life of every store, for nothing.
          // (Copilot.)
          //
          // ⚠ NO TEST, deliberately, and this note is the substitute. `head` is
          // closure state, so asserting it would need a seam that exists only to be
          // asserted — and `byteLength` reports 16 either way, so the giveaway is
          // the backing store, which is not reachable from outside. Verified once by
          // hand instead: a 16-byte `subarray` of a 64 KB chunk reports
          // `buffer.byteLength` 65536 and `view.buffer === chunk.buffer`; the
          // `Buffer.from` copy reports 8192 and shares nothing.
          const want = Buffer.from(chunk.subarray(0, SIGNATURE_BYTES - headLen));
          head.push(want);
          headLen += want.length;
        }
        size += chunk.length;
        writer.write(chunk);
      },
      async commit(contentType: string): Promise<boolean> {
        try {
          // ⚠⚠ An empty body is ABORTED, not just declined. Returning false here
          // without touching the writer left its stream open and its temp file on
          // disk — one leaked fd and one orphaned `.tmp` per request, from an origin
          // answering 200 with `Content-Length: 0`, which nothing sweeps and which
          // eviction cannot see because the index never learned about it. Exactly
          // the leak `openLocalWrite`'s own comment says the design must not have,
          // reached through the one exit that skipped the cleanup. (Copilot.)
          if (size === 0) {
            await writer.abort();
            return false;
          }
          // ⚠⚠ THE CONTENT TYPE IS A CLAIM, and until this check nothing tested
          // it. `cacheable` asks `kindForContentType`, which reads the header the
          // ORIGIN sent — so an origin someone else controls answers
          // `Content-Type: image/png` with an HTML document and we would keep the
          // bytes, then serve them back under our own name with
          // `Content-Disposition: inline`. The URL is minted to the poster's own
          // client, so getting it to a victim is not a hurdle.
          //
          // ⚠ This is where it belongs rather than in either backend: it is a fact
          // about the BYTES, identical for a file, a bucket and the hosted dropper,
          // and putting it here means a backend cannot be added without it.
          //
          // ⚠ An unrecognised format is REFUSED, so a future image format stops
          // being cached until it is listed. That is the safe direction — the proxy
          // still serves it, so the failure is "no saving", not "no picture".
          if (!imageSignatureOf(Buffer.concat(head))) {
            await writer.abort();
            return false;
          }
          if (!(await writer.commit(contentType))) return false;
          try {
            recordCached({ key, backend: cfg.mode, contentType, size });
          } catch {
            // The bytes landed but the index did not, so nothing could find them.
            // ⚠ For `s3` this matters MORE than for `local`, not less: an unindexed
            // file is dead weight on a volume the operator can see and reclaim, but
            // an unindexed object is dead weight they are billed for until a
            // lifecycle rule they may not have set gets round to it.
            // ⚠ `dropper` gets NO rollback, and that is a capability fact, not an
            // oversight: the cell holds an upload key only — the split key sets
            // exist so a compromised cell cannot delete from the fleet's bucket —
            // and hosted previews/ always has the 30-day lifecycle rule to reclaim
            // an unindexed object.
            if (cfg.mode === 'local') await removeLocal(cfg, key);
            else if (cfg.mode === 's3') await removeS3(cfg, key);
            return false;
          }
          return true;
        } catch {
          return false;
        }
      },
      async abort(): Promise<void> {
        await writer.abort().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}
