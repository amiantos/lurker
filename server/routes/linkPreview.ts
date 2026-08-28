// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Three endpoints, all authenticated:
//
//   POST /api/link-preview/resolve       urls[] → descriptors[]
//   GET  /api/link-preview/media/:token  → image bytes, streamed via the decoder
//   GET  /api/link-preview/poster/:key   → a stored poster frame, from the byte cache
//
// REST rather than WebSocket because these are reads, and Lurker's reads are
// REST. The byte endpoints have to be URLs regardless — that's what an <img src> is.
//
// ⚠⚠ Since the lurker-previews split, this process NEVER dials an origin: the
// media route asks the decoder's /fetch and relays. What stays here is the
// client-facing half — the token capability, auth, throttles, the byte cache and
// the security headers a browser sees — and the status translation for <img>
// consumers: the decoder's precise 502-vs-503 becomes what an <img> can act on
// (a dead origin's 404 is permanent on purpose; a 503 keeps its Retry-After so
// the element retries).

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { RequestThrottle } from '../middleware/rateLimit.js';
import {
  byteCacheKey,
  beginStore,
  cacheEnabled,
  cacheable,
  lookup,
  trackPendingStore,
} from '../services/previewCache/index.js';
import { resolvePreview, toDescriptor, MAX_URLS_PER_REQUEST } from '../services/linkPreview.js';
import { proxyableContentType, MAX_IMAGE_PROXY_BYTES } from '../services/previewShared.js';
import { decoderFetch } from '../services/previewClient.js';
import { verifyProxyToken, verifyPosterToken } from '../services/mediaProxyToken.js';
import { previewsEnabled } from '../utils/previews.js';
import { SlotPool } from '../utils/slotPool.js';

const router = Router();
router.use(requireAuth);

/**
 * Per-account cap on resolutions.
 *
 * Keyed by user rather than by IP, unlike the auth limiters: this route is
 * authenticated, so the account is the accurate identity, and an IP key would
 * lump everyone behind one household NAT together. The ceiling is set for a
 * human scrolling fast through link-heavy scrollback — clients batch and dedupe
 * before asking, so hitting this means something is looping.
 */
const resolveThrottle = new RequestThrottle({
  windowMs: 60_000,
  maxRequests: 120,
});

/**
 * Per-account cap on BYTE requests (the media route and the poster route share it —
 * they are the same resource class, "images a card renders").
 *
 * ⚠ The byte endpoints need their own. Only `/resolve` was throttled once, so any
 * authenticated session could loop byte GETs for a token it already held. Set well above
 * what a person browsing generates (the browser and iOS URLCache hold these for a day, so
 * a re-scroll costs nothing) and far below what a loop does.
 */
const mediaThrottle = new RequestThrottle({ windowMs: 60_000, maxRequests: 300 });

/**
 * The response headers every byte answer carries, cached or relayed.
 *
 * ⚠⚠ Extracted rather than duplicated, and that is the point. These are the
 * security headers that keep a third party's bytes from being interpreted as
 * anything but the media type we allowlisted, and there are now THREE ways a body
 * leaves this file. Two copies would drift, and the copy that drifts is the
 * one nobody looks at — a cached image served without `nosniff` is the same
 * vulnerability as an uncached one, arrived at by omission.
 */
function applyMediaHeaders(res: Response, contentType: string): void {
  res.setHeader('Content-Type', contentType);
  // Belt and braces against the response being interpreted as anything other
  // than the media type we just allowlisted.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // No filename: it would come from a URL someone else controls.
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // The token is a pure function of the URL, so a given token always denotes
  // the same bytes — safe to cache hard, and it's what keeps a scroll through
  // an image-heavy channel from re-proxying on every pass. `private` because
  // the response travels over an authenticated session.
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
}

/**
 * Byte relays in flight across the whole instance.
 *
 * Still needed with the fetches gone to the decoder, because two of the resources it
 * bounds never left: a CACHE HIT reads a whole object into RSS (bypassing the pool for
 * hits let one session at the throttle ceiling park ~300 x 8 MB while the pool sat idle,
 * and it got WORSE the warmer the cache was), and a relay holds a socket pair and a
 * response for the length of a transfer. What moved is only the third resource — origin
 * sockets and their uncancellable DNS lookups, which are the decoder's own pool's problem
 * now, in a process where the worst case is previews getting slower.
 */
const mediaPool = new SlotPool({ size: 24, maxQueued: 200, waitMs: 3_000 });

/**
 * Ceiling on one relayed transfer, start to finish.
 *
 * ⚠ The decoder bounds its own origin-side transfer the same way, but this end holds a
 * response and a pool slot for the length of the relay, and a bound that lives only on
 * the far side of a seam is a bound this process merely hopes about.
 */
const MAX_TRANSFER_MS = 5 * 60_000;

router.post('/resolve', async (req: Request, res: Response) => {
  // Same inner gate as the byte routes. The router isn't mounted when the feature is off, so
  // this is unreachable in a running server — but every endpoint answering the flag the same
  // way is what keeps that true if the mounting ever moves.
  if (!previewsEnabled()) {
    res.status(404).end();
    return;
  }

  // ⚠ `?? {}`, because Express 5's body-parser leaves `req.body` UNDEFINED rather than empty
  // for any request that isn't JSON — no Content-Type, `text/plain`, a form post. Reading
  // through it threw a TypeError into the error middleware, so the 400 two lines down was
  // dead code for precisely the malformed requests it exists to answer.
  const body = (req.body ?? {}) as { urls?: unknown };
  if (!Array.isArray(body.urls)) {
    res.status(400).json({ error: 'urls must be an array' });
    return;
  }

  const urls = body.urls
    .filter((u): u is string => typeof u === 'string')
    .slice(0, MAX_URLS_PER_REQUEST);

  const verdict = resolveThrottle.allow(String(req.user!.id));
  if (!verdict.ok) {
    res.set('Retry-After', String(verdict.retryAfter));
    res.status(429).json({ error: 'too many preview requests — slow down' });
    return;
  }

  // Resolved in parallel, but `resolvePreview` never rejects and coalesces
  // duplicates internally, so this can't turn into an unbounded fan-out or an
  // unhandled rejection.
  const previews = await Promise.all(urls.map(async (u) => toDescriptor(await resolvePreview(u))));
  res.json({ previews });
});

router.get('/media/:token', async (req: Request, res: Response) => {
  if (!previewsEnabled()) {
    res.status(404).end();
    return;
  }

  const verdict = mediaThrottle.allow(String(req.user!.id));
  if (!verdict.ok) {
    res.set('Retry-After', String(verdict.retryAfter));
    res.status(429).json({ error: 'too many media requests — slow down' });
    return;
  }

  // The token is the capability: the server minted it during resolve, after the
  // URL had already passed the decoder's guard, so a client can only replay a
  // decision we made. It cannot author one. (The decoder re-vets from scratch
  // anyway — the token proves we approved this URL at some point; it says nothing
  // about where the name points NOW.)
  const raw = verifyProxyToken(String(req.params.token));
  if (!raw) {
    res.status(403).end();
    return;
  }

  // ⚠ The cache is consulted before the fetch, but NOT before the pool. An
  // earlier version returned a hit ahead of `mediaPool.acquire()` on the
  // reasoning that a hit does no outbound work — true of sockets, and inverted
  // for memory. A hit reads the whole object into RSS, so bypassing the only
  // concurrency bound let one session at the throttle ceiling park ~300 x 8 MB
  // while the pool sat idle. The pool bounds a resource the cache also spends.
  const isRange = typeof req.headers.range === 'string' && req.headers.range !== '';
  const cacheKey = byteCacheKey(raw);

  if (!(await mediaPool.acquire())) {
    // Saturated, not broken. 503 + Retry-After so a media element backs off and retries,
    // rather than 404, which an <img> treats as a permanent verdict and never re-asks.
    res.set('Retry-After', '5');
    res.status(503).end();
    return;
  }

  // ⚠ Registered BEFORE the fetch is awaited, and it owns the slot release.
  //
  // Attaching this after the await — which can take the decoder's whole headers budget —
  // meant a client that aborted during the fetch had already fired `close`, so the listener
  // written to stop us holding the relay open was attached to an event that would never fire
  // again: connect-then-abort as a cheap amplifier. `close` on a response fires whether it
  // finished or aborted, which makes it the one place that always runs — so it is also where
  // the pool slot goes back. Aborting the CONTROLLER covers the window before there is a
  // stream to destroy.
  const controller = new AbortController();
  let upstream: Awaited<ReturnType<typeof decoderFetch>> | null = null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(transferDeadline);
    controller.abort();
    upstream?.stream.destroy();
    mediaPool.release();
  };
  // Bounds slot occupancy even when nothing else will — see MAX_TRANSFER_MS. Tearing the
  // response down routes through `release` via `close`, so there is still one release path.
  const transferDeadline = setTimeout(() => {
    upstream?.stream.destroy();
    res.destroy();
  }, MAX_TRANSFER_MS);
  transferDeadline.unref();

  res.on('close', release);
  // A response already gone by the time we got a slot never emits `close` again.
  // ⚠ The RESPONSE only — an Express request whose body was consumed reads as destroyed
  // in the ordinary course of things.
  if (res.destroyed) {
    release();
    return;
  }

  // ⚠ Inside the pool, and after `release` is wired to the response's `close`, so
  // a hit gives its slot back the same way a relay does. `lookup` never throws —
  // that is the cache module's headline promise.
  if (cacheEnabled() && !isRange) {
    const hit = await lookup(cacheKey);
    if (hit) {
      applyMediaHeaders(res, hit.contentType);
      res.setHeader('Content-Length', String(hit.body.length));
      res.status(200).end(hit.body);
      return;
    }
  }

  try {
    upstream = await decoderFetch(
      raw,
      // ⚠ Still forwarded. An origin may answer a plain GET with a 206 of its own accord,
      // and a request that arrives with a Range must be asked about the SAME bytes the
      // client wants — not silently answered from byte zero. The decoder validates it.
      typeof req.headers.range === 'string' ? req.headers.range : undefined,
      controller.signal,
    );
    // The client left, or the stream died, while we were awaiting. Without this the response
    // never gets its `end()`, so the browser hangs on a half-open response.
    if (released || res.destroyed || upstream.stream.destroyed) {
      // ⚠ Destroyed HERE, not delegated to `release()` — if the client left during the
      // fetch, `release()` has already run and latched, and the stream we have only just
      // been handed would stay open, unread.
      upstream.stream.destroy();
      release();
      return;
    }

    // The decoder's contract, translated for an <img>:
    //   200/206  relay (and maybe cache)
    //   416      the origin's answer to an unsatisfiable range; forward as-is
    //   413      over the byte cap — a fact about the URL
    //   503      transient (origin backoff or decoder saturation); Retry-After survives
    //   403/404/502 and anything else → 404, the permanent verdict a dead origin,
    //            refused URL or non-image has earned. ⚠⚠ Only 503 may stay transient:
    //            "not now" and "not ever" being different answers is the whole reason
    //            the decoder keeps them distinct across the seam.
    if (upstream.status === 416) {
      upstream.stream.destroy();
      if (upstream.headers['content-range']) {
        res.setHeader('Content-Range', String(upstream.headers['content-range']));
      }
      res.status(416).end();
      return;
    }
    if (upstream.status === 503) {
      upstream.stream.destroy();
      const retry = Number(upstream.headers['retry-after']);
      res.set('Retry-After', String(Number.isFinite(retry) && retry > 0 ? retry : 60));
      res.status(503).end();
      return;
    }
    if (upstream.status === 413) {
      upstream.stream.destroy();
      res.status(413).end();
      return;
    }
    // ⚠⚠ Parameters stripped and lowercased BEFORE the allowlist. `kindForContentType` refuses
    // SVG by an exact `=== 'image/svg+xml'` match, so a raw `image/svg+xml; charset=utf-8` from a
    // non-conformant or compromised decoder would miss it, hit `startsWith('image/')`, and be
    // relayed inline under our origin. The origin-side fetch normalizes its own copy; this is
    // the enforcement point on data we treat as untrusted, so it normalizes independently.
    const contentType = String(upstream.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (
      (upstream.status !== 200 && upstream.status !== 206) ||
      !proxyableContentType(contentType)
    ) {
      upstream.stream.destroy();
      res.status(404).end();
      return;
    }

    applyMediaHeaders(res, contentType);
    // Range plumbing is the decoder's homework, forwarded: it only claims Accept-Ranges
    // when the origin demonstrated it (the token-match rule lives there now).
    if (upstream.headers['accept-ranges']) {
      res.setHeader('Accept-Ranges', String(upstream.headers['accept-ranges']));
    }
    if (upstream.headers['content-range']) {
      res.setHeader('Content-Range', String(upstream.headers['content-range']));
    }
    // ⚠ Content-Length is only forwarded when we KNOW we'll send exactly that many bytes —
    // echoing it while the body gets cut at the cap below is a length/body mismatch the
    // client reads as a broken transfer.
    const declared = Number(upstream.headers['content-length']);
    const cap = MAX_IMAGE_PROXY_BYTES;
    if (Number.isFinite(declared) && declared <= cap) {
      res.setHeader('Content-Length', String(declared));
    }
    res.status(upstream.status === 206 ? 206 : 200);

    // ⚠⚠ STREAMED to the cache, never buffered — the destination is a file, so there was
    // never a reason for the bytes to sit in RSS on the way there. `declared` when the
    // decoder gave one, the cap when it did not: the writer reserves room before the first
    // byte, and under-reserving is how the ceiling gets crossed.
    // ⚠ The origin's own Cache-Control is forwarded across the seam by the decoder and
    // consulted HERE, at the store decision. See `originPermitsStoring` — GitHub marks its
    // unrendered-card placeholder `max-age=0`, and we used to keep it for a week.
    const wantCache =
      cacheable(contentType, isRange, upstream.headers['cache-control'] as string | undefined) &&
      upstream.status !== 206;
    const writer = wantCache
      ? await beginStore(cacheKey, Number.isFinite(declared) ? declared : cap)
      : null;
    // ⚠⚠ `beginStore` is the one await between the released-check above and the stream
    // handlers below, and it can take real time (a temp-file open on `local`, the opening
    // POST to `dropper`). A client that aborts DURING it fires `res`'s `close` → `release()`
    // → `upstream.stream.destroy()`, whose own `close` then fires on a later tick — before the
    // `stream.on('close')` handler that would abort the writer exists. Without this the writer
    // is neither aborted nor committed: a leaked fd + orphaned `.tmp` on `local`, a dangling
    // upload on `dropper`, and `trackPendingStore`'s count never settles. So re-check, and if
    // we lost the race, undo the store we just opened and settle its decision here.
    if (writer && released) {
      void writer.abort();
      return;
    }
    // Registered only once there is something to decide, and AFTER the race check above so it
    // is never left dangling. Settled on every exit below. Only a test waits on it — see
    // `trackPendingStore`.
    const settleDecision = writer ? trackPendingStore() : null;

    // ⚠ The cap enforced on bytes actually seen, EVEN THOUGH the decoder enforces the same
    // figure origin-side: the decoder is data, not policy, and a skewed or compromised one
    // must not be able to stream this process an unbounded body.
    let sent = 0;
    const stream = upstream.stream;
    stream.on('data', (chunk: Buffer) => {
      sent += chunk.length;
      if (sent > cap) {
        stream.destroy();
        res.destroy();
        return;
      }
      writer?.write(chunk);
    });
    stream.on('error', () => res.destroy());

    // ⚠⚠ `end` is what means "a COMPLETE object", and it is the only thing that may
    // authorise a store. A body cut short is still a stream of real bytes — cached, it
    // becomes a permanently broken image served to everyone afterwards and held by their
    // browsers for a day. `close` fires either way, which is why it cannot be the trigger.
    let ended = false;
    stream.on('end', () => {
      ended = true;
    });

    // ⚠ DECIDED on `close`, because that is the one event guaranteed to fire on every path.
    stream.on('close', () => {
      if (!writer) return;
      // ⚠⚠ THE BODY MUST BE FRAMED ALL THE WAY BACK TO THE ORIGIN, and this hop's own
      // framing cannot prove that: the decoder's relay re-frames whatever it got, so an
      // origin body terminated only by its connection closing — cut or complete, the
      // protocol cannot tell — arrives here as pristine chunked. The attestation header
      // is the decoder passing the evidence across the seam (absent = the origin's
      // framing was unverifiable, so the bytes are uncacheable however clean they look).
      // Truncation of an attested body still shows mechanically on THIS hop — a cut
      // chunked stream never emits `end`, a Content-Length mismatch never balances —
      // which is what `ended` and the declared-length check below hold.
      const originFramed = upstream!.headers['x-lurker-origin-framed'] === '1';
      const chunked = String(upstream!.headers['transfer-encoding'] ?? '')
        .toLowerCase()
        .includes('chunked');
      const framed = originFramed && (chunked || (Number.isFinite(declared) && declared === sent));
      if (!ended || !framed || sent > cap) {
        void writer.abort().finally(() => settleDecision?.());
        return;
      }
      // Deliberately not awaited: the reader already has their bytes, and a slow
      // disk must not hold the response open. Failures are the cache's own problem
      // — the writer swallows them and simply stays a miss.
      void writer
        .commit(contentType)
        .catch(() => {})
        .finally(() => settleDecision?.());
    });
    stream.pipe(res);
  } catch {
    // `decoderFetch` rejects only for the seam itself — no decoder configured, connect
    // refused, headers that never came, or our own teardown racing it. That is transient
    // BY DEFINITION (a deploy in progress, a container restarting), and answering 404
    // would make an <img> hold "missing" for good over a thirty-second deploy window.
    release();
    if (!res.headersSent) {
      res.set('Retry-After', '30');
      res.status(503).end();
    }
  }
});

router.get('/poster/:token', async (req: Request, res: Response) => {
  if (!previewsEnabled()) {
    res.status(404).end();
    return;
  }
  // Same budget as the media route: a poster is an image a card renders, and a session
  // replaying byte GETs is the same loop whichever route it loops.
  const verdict = mediaThrottle.allow(String(req.user!.id));
  if (!verdict.ok) {
    res.set('Retry-After', String(verdict.retryAfter));
    res.status(429).json({ error: 'too many media requests — slow down' });
    return;
  }

  // ⚠⚠ A SIGNED token, verified to a poster key — NOT a raw key. `posterCacheKey` and
  // `byteCacheKey` are unsalted hashes sharing one cache index, so accepting a bare key here
  // let any authenticated user read whatever the instance had proxied under `byteCacheKey(url)`
  // — the cross-user oracle the media route's HMAC prevents. The signature is what proves this
  // instance minted the key into a descriptor, exactly as `/media` proves it approved a URL.
  // A bad token is a 403, the same answer `/media` gives a forged one.
  const key = verifyPosterToken(String(req.params.token));
  if (!key) {
    res.status(403).end();
    return;
  }

  // ⚠⚠ Cache or nothing, BY DESIGN. A poster is the one preview image with no origin URL —
  // these bytes were decoded by this instance and exist nowhere else — so there is no
  // proxy-path fallback, and a miss (evicted, cache turned off, a restored backup) is an
  // honest 404: the card renders without its poster, which is a supported state. The
  // deliberately-unpooled read is fine at this size: posters are ≤640px q4 JPEGs, and the
  // shared throttle above bounds the rate.
  if (!cacheEnabled()) {
    res.status(404).end();
    return;
  }
  const hit = await lookup(key);
  if (!hit) {
    res.status(404).end();
    return;
  }
  applyMediaHeaders(res, hit.contentType);
  res.setHeader('Content-Length', String(hit.body.length));
  res.status(200).end(hit.body);
});

export default router;
