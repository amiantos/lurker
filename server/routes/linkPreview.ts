// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Two endpoints, both authenticated:
//
//   POST /api/link-preview/resolve      urls[] → descriptors[]
//   GET  /api/link-preview/media/:token → the bytes, streamed
//
// REST rather than WebSocket because these are reads, and Lurker's reads are
// REST (search is the one deliberate exception, and it's deliberate because it
// needs a token/reply round trip the REST surface can't express). The byte
// endpoint has to be a URL regardless — that's what an <img src> is.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { RequestThrottle } from '../middleware/rateLimit.js';
import { resolvePreview, toDescriptor, MAX_IMAGE_PROXY_BYTES } from '../services/linkPreview.js';
import { verifyProxyToken } from '../services/mediaProxyToken.js';
import { normalizeUrl, safeRequest, fetchingEnabled } from '../services/linkFetch.js';

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

/** Cap per request, so one call can't fan out into a hundred outbound fetches. */
const MAX_URLS_PER_REQUEST = 20;

router.post(
  '/resolve',
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { urls?: unknown };
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
    const previews = await Promise.all(
      urls.map(async (u) => toDescriptor(await resolvePreview(u))),
    );
    res.json({ previews });
  }),
);

/**
 * Content types the proxy will serve.
 *
 * An allowlist, not a denylist. The endpoint returns bytes from an arbitrary
 * origin under OUR origin, so anything that a browser might execute in our
 * security context has to be impossible rather than merely discouraged — which
 * rules out `text/html` and, emphatically, `image/svg+xml`: SVG is a scripting
 * format wearing a picture's clothes, and the uploader already refuses it for
 * exactly this reason.
 */
function proxyableContentType(contentType: string): boolean {
  if (contentType === 'image/svg+xml') return false;
  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/')
  );
}

router.get(
  '/media/:token',
  asyncHandler(async (req: Request, res: Response) => {
    if (!fetchingEnabled()) {
      res.status(404).end();
      return;
    }

    // The token is the capability: the server minted it during resolve, after the
    // URL had already passed the guard, so a client can only replay a decision we
    // made. It cannot author one.
    const raw = verifyProxyToken(String(req.params.token));
    if (!raw) {
      res.status(403).end();
      return;
    }

    // Re-vetted from scratch anyway. The token proves we approved this URL at some
    // point; it says nothing about where the name points NOW, and a DNS record
    // that was public an hour ago can be 10.0.0.5 today. safeRequest re-runs the
    // pinned lookup on every hop.
    const url = normalizeUrl(raw);
    if (!url) {
      res.status(403).end();
      return;
    }

    try {
      const upstream = await safeRequest(url, {
        accept: 'image/*,video/*,audio/*;q=0.9,*/*;q=0.5',
      });

      if (upstream.status !== 200 || !proxyableContentType(upstream.contentType)) {
        upstream.stream.destroy();
        res.status(404).end();
        return;
      }
      const declared = Number(upstream.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_PROXY_BYTES) {
        upstream.stream.destroy();
        res.status(413).end();
        return;
      }

      res.setHeader('Content-Type', upstream.contentType);
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
      if (upstream.headers['content-length']) {
        res.setHeader('Content-Length', String(upstream.headers['content-length']));
      }

      // Enforce the cap on bytes actually seen, not on the declared length — an
      // origin can omit Content-Length or lie about it.
      let sent = 0;
      upstream.stream.on('data', (chunk: Buffer) => {
        sent += chunk.length;
        if (sent > MAX_IMAGE_PROXY_BYTES) {
          upstream.stream.destroy();
          res.destroy();
        }
      });
      upstream.stream.on('error', () => res.destroy());
      upstream.stream.pipe(res);
      // A viewer who scrolls away mid-download shouldn't leave us holding a socket
      // to the origin.
      res.on('close', () => upstream.stream.destroy());
    } catch {
      // Blocked address, timeout, reset — all the same to a caller waiting on an
      // image, and none of them worth distinguishing in a status code.
      if (!res.headersSent) res.status(404).end();
    }
  }),
);

export default router;
