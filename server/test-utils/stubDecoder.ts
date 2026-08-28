// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A stand-in for the lurker-previews decoder, faithful to its CONTRACT
// (lurker-dev/LINK_PREVIEWS_ISOLATION.md — the status table in resolve.ts there).
//
// ⚠⚠ This stub is the contract's second copy, on purpose: the cell's suites pin
// "what the cell does GIVEN a conformant decoder", and the decoder's own repo pins
// conformance. If the contract changes, BOTH change, and this header is the
// tripwire. What the stub deliberately does NOT reimplement is the decoder's
// judgement — no SSRF guard, no scrape, no cooldown state — because the cell
// tests' origins are loopback fixtures the real guard would refuse.
//
//   /resolve  → whatever the test's `onResolve` rule says, serialized per contract
//   /fetch    → a transparent relay of the requested (loopback) origin, with the
//               decoder's documented status mapping applied — the stub speaks the
//               DECODER's side of the seam (502 for a dead origin, 404 for a
//               non-image); folding those to the client-facing 404 is the cell's
//               job and exactly what the route tests assert:
//                 200/206 image → relayed with its headers
//                 416           → forwarded with Content-Range
//                 429/5xx       → 503 + Retry-After   (transient, never collapsed)
//                 other non-ok / non-image → 404
//                 dead origin   → 502
//                 declared size > 8 MB (or Content-Range total) → 413

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubResolveOk {
  status: 'ok';
  meta: Partial<{
    kind: string;
    title: string | null;
    description: string | null;
    siteName: string | null;
    author: string | null;
    imageUrl: string | null;
    imageWidth: number | null;
    imageHeight: number | null;
    embedUrl: string | null;
    mime: string | null;
  }>;
  /** Raw JPEG bytes; the stub base64s them the way the decoder does. */
  poster?: { jpeg: Buffer; width: number | null; height: number | null };
}

export type StubResolveAnswer =
  | StubResolveOk
  | { status: 'none' }
  | { status: 'refused'; reason?: string }
  | { status: 'dead' }
  | { status: 'backoff'; retryAfterS: number }
  /** Answer HTTP-500-shaped nonsense, which the cell must read as `down`. */
  | { status: 'garbage' };

export interface StubDecoder {
  /** Value for LURKER_PREVIEWS_URL. */
  url: string;
  /** Every URL /resolve was asked about, in order. */
  resolveAsks: Array<{ url: string; wantPoster: boolean }>;
  /** Every URL /fetch was asked to relay, in order. */
  fetchAsks: Array<{ url: string; range?: string }>;
  /** Rule for /resolve answers. Default: everything is `dead`. */
  onResolve: (url: string, wantPoster: boolean) => StubResolveAnswer;
  /** When set, /fetch answers this instead of relaying — for simulating a decoder
   *  that MISBEHAVES (wrong content type, oversize body), so the cell's own
   *  re-checks can be pinned. Cleared by setting null. */
  onFetch: ((url: string, res: import('node:http').ServerResponse) => void) | null;
  close: () => Promise<void>;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The decoder's `contentRangeTotal`, faithfully: a number, 'unknown' (absent or
 *  a legal `/*`), or 'unusable' — which the decoder REFUSES with 413, the
 *  more-absurd-the-claim-the-more-permissive-the-answer inversion being the bug
 *  class those tests exist for. */
function rangeTotal(header: string | undefined): number | 'unknown' | 'unusable' {
  if (!header) return 'unknown';
  const first = header.split(',')[0];
  const slash = first.lastIndexOf('/');
  if (slash === -1) return 'unusable';
  const after = first.slice(slash + 1).trim();
  if (after === '*') return 'unknown';
  if (!/^\d+$/.test(after)) return 'unusable';
  const n = Number(after);
  return Number.isSafeInteger(n) ? n : 'unusable';
}

function answerResolve(res: http.ServerResponse, answer: StubResolveAnswer): void {
  switch (answer.status) {
    case 'ok': {
      const meta = {
        kind: 'page',
        title: null,
        description: null,
        siteName: null,
        author: null,
        imageUrl: null,
        imageWidth: null,
        imageHeight: null,
        embedUrl: null,
        mime: null,
        ...answer.meta,
        ...(answer.poster
          ? {
              poster: {
                jpegBase64: answer.poster.jpeg.toString('base64'),
                width: answer.poster.width,
                height: answer.poster.height,
              },
            }
          : {}),
      };
      const body = JSON.stringify(meta);
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }
    case 'none':
      res.writeHead(204).end();
      return;
    case 'refused':
      res
        .writeHead(403, { 'content-type': 'application/json' })
        .end(JSON.stringify({ reason: answer.reason ?? 'refused by the stub' }));
      return;
    case 'dead':
      res.writeHead(502).end();
      return;
    case 'backoff':
      res.writeHead(503, { 'retry-after': String(answer.retryAfterS) }).end();
      return;
    case 'garbage':
      res.writeHead(500, { 'content-type': 'text/plain' }).end('stub exploding on request');
      return;
  }
}

/** Relay one loopback origin the way the decoder's /fetch contract says. */
function relayFetch(res: http.ServerResponse, url: string, range: string | undefined): void {
  const req = http.get(url, { headers: range ? { range } : {} }, (origin) => {
    const status = origin.statusCode || 0;
    const contentType = String(origin.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    if (status === 416) {
      origin.resume();
      const head: Record<string, string> = {};
      if (origin.headers['content-range']) {
        head['content-range'] = String(origin.headers['content-range']);
      }
      res.writeHead(416, head).end();
      return;
    }
    const ok = status === 200 || status === 206;
    if (!ok) {
      origin.resume();
      if (status === 429 || (status >= 500 && status <= 599)) {
        res.writeHead(503, { 'retry-after': String(origin.headers['retry-after'] ?? 60) }).end();
        return;
      }
      res.writeHead(404).end();
      return;
    }
    const isImage = contentType.startsWith('image/') && contentType !== 'image/svg+xml';
    if (!isImage) {
      origin.resume();
      res.writeHead(404).end();
      return;
    }
    const declared = Number(origin.headers['content-length']);
    const total = rangeTotal(origin.headers['content-range'] as string | undefined);
    if (
      (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) ||
      total === 'unusable' ||
      (typeof total === 'number' && total > MAX_IMAGE_BYTES)
    ) {
      origin.resume();
      res.writeHead(413).end();
      return;
    }

    const head: Record<string, string> = { 'content-type': contentType };
    if (Number.isFinite(declared) && declared <= MAX_IMAGE_BYTES) {
      head['content-length'] = String(declared);
    }
    // The framing attestation, faithfully: present iff the ORIGIN's body framing was
    // verifiable. Without it a relay launders connection-close truncation into clean
    // chunked — the seam bug the cell's unframed-body cache test exists to catch.
    const chunkedOrigin = String(origin.headers['transfer-encoding'] ?? '')
      .toLowerCase()
      .includes('chunked');
    if (chunkedOrigin || Number.isFinite(declared)) {
      head['x-lurker-origin-framed'] = '1';
    }
    // Forwarded so the cell's STORE decision can consult it, exactly as the real decoder
    // does. GitHub marks the placeholder it serves for a card it could not render
    // `cache-control: public, max-age=0` — the only thing distinguishing it from a real
    // card, since the bytes are a perfectly valid PNG either way.
    if (origin.headers['cache-control']) {
      head['cache-control'] = String(origin.headers['cache-control']);
    }
    // The decoder's advertisement rule, faithfully: a 206, or a TOKEN match on the
    // origin's (possibly comma-joined) Accept-Ranges — never an echo of the raw value.
    const upstreamRanges =
      status === 206 ||
      String(origin.headers['accept-ranges'] || '')
        .toLowerCase()
        .split(',')
        .some((token) => token.trim() === 'bytes');
    if (upstreamRanges) head['accept-ranges'] = 'bytes';
    if (origin.headers['content-range']) {
      head['content-range'] = String(origin.headers['content-range']);
    }
    res.writeHead(status === 206 ? 206 : 200, head);
    origin.pipe(res);
    origin.on('error', () => res.destroy());
  });
  // The decoder tears its origin request down when its caller leaves — the stub must
  // propagate the same way or the cell's mid-fetch-abandonment test would watch a
  // socket the STUB is leaking and blame the cell.
  res.on('close', () => req.destroy());
  req.on('error', () => {
    if (!res.headersSent) res.writeHead(502).end();
    else res.destroy();
  });
}

/**
 * Start a stub and point the cell at it: sets LURKER_PREVIEWS_URL, and `close()`
 * restores whatever was there before.
 */
export async function startStubDecoder(): Promise<StubDecoder> {
  const stub: StubDecoder = {
    url: '',
    resolveAsks: [],
    fetchAsks: [],
    onResolve: () => ({ status: 'dead' }),
    onFetch: null,
    close: async () => {},
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as {
        url: string;
        range?: string;
        wantPoster?: boolean;
      };
      if (req.url === '/resolve') {
        stub.resolveAsks.push({ url: body.url, wantPoster: body.wantPoster === true });
        answerResolve(res, stub.onResolve(body.url, body.wantPoster === true));
        return;
      }
      if (req.url === '/fetch') {
        stub.fetchAsks.push({ url: body.url, ...(body.range ? { range: body.range } : {}) });
        if (stub.onFetch) {
          stub.onFetch(body.url, res);
          return;
        }
        relayFetch(res, body.url, body.range);
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const saved = process.env.LURKER_PREVIEWS_URL;
  process.env.LURKER_PREVIEWS_URL = stub.url;
  stub.close = async () => {
    if (saved === undefined) delete process.env.LURKER_PREVIEWS_URL;
    else process.env.LURKER_PREVIEWS_URL = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return stub;
}
