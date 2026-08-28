// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The `dropper` byte cache through the ROUTE, against a stub dropper service
// that remembers what it was sent. The s3 suite is the template and the
// rationale (see its header); this file holds the dropper mode to the same bar.
//
// ⚠ What's mocked is the POLICY and the far end, never the mechanism: the
// address guard is inverted so a loopback origin is reachable, the dropper is a
// stand-in http server, and — for the two read-back tests only — global fetch
// stands in for the CDN, because config validation (rightly) refuses an http
// public base URL and the real one would mean live network in a test. The
// multipart encoding, the staging file, the index write, the descriptor mint,
// Express, the token, the throttles and the pool are all shipping code.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import { startStubDecoder, type StubDecoder } from '../test-utils/stubDecoder.js';

const ctx = setupTestDb('routes-link-preview-droppercache');

/** What the stub dropper recorded for one request. */
interface Stored {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let stores: Stored[] = [];
/** Flip to make every store fail, without changing anything else. */
let dropperRejects = false;
/** Flip to answer stores with a URL from a DIFFERENT layout — the KEY_PREFIX /
 *  wrong-base misconfiguration the cell must refuse to record. */
let dropperWrongLayout = false;

let dropper: http.Server;
let dropperBase: string;

const API_KEY = 'test-upload-key';
const CDN = 'https://cdn.example.com/previews';

let stub: StubDecoder;
let app: Express;
let agent: LurkerTestAgent;
let mintProxyToken: typeof import('../services/mediaProxyToken.js').mintProxyToken;
let countCached: typeof import('../db/previewCache.js').countCached;
let whenStoresSettle: typeof import('../services/previewCache/index.js').whenStoresSettle;
let byteCacheKey: typeof import('../services/previewCache/index.js').byteCacheKey;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let handler: Handler;
let origin: http.Server;
let base: string;
let originHits = 0;

const tokenFor = (p: string): string => mintProxyToken(`${base}${p}`);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function servePng(body = PNG): void {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.length) });
    res.end(body);
  };
}

beforeAll(async () => {
  stub = await startStubDecoder();
  // These suites resolve direct-image URLs cold, so the stub answers the way the real
  // decoder answers direct media: the URL IS the content, echoed back as `imageUrl`.
  stub.onResolve = (url) => ({
    status: 'ok',
    meta: { kind: 'image', imageUrl: url, mime: 'image/png' },
  });
  // The stub dropper. Started BEFORE the cache config is read, because the
  // config is resolved once per process and has to point at a real port.
  dropper = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      stores.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
      if (req.method === 'POST' && req.url === '/api/previews') {
        if (dropperRejects) {
          res
            .writeHead(500, { 'content-type': 'application/json' })
            .end('{"error":"storage error"}');
          return;
        }
        // Answer the way the real dropper does: the public URL for the stored
        // key, which the cell checks against its own mint before recording.
        const match = /name="key"\r?\n\r?\n([0-9a-f]{64})/.exec(body.toString('latin1'));
        const storedKey = match ? match[1] : 'unparsed';
        const url = dropperWrongLayout
          ? `https://cdn.example.com/uploads/previews/${storedKey}`
          : `${CDN}/${storedKey}`;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ url }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => dropper.listen(0, '127.0.0.1', resolve));
  dropperBase = `http://127.0.0.1:${(dropper.address() as AddressInfo).port}`;

  process.env.LURKER_PREVIEW_CACHE_MODE = 'dropper';
  process.env.LURKER_PREVIEW_CACHE_DROPPER_URL = dropperBase;
  process.env.LURKER_PREVIEW_CACHE_DROPPER_API_KEY = API_KEY;
  process.env.LURKER_PREVIEW_CACHE_DROPPER_PUBLIC_BASE_URL = CDN;
  process.env.LURKER_PREVIEW_CACHE_DIR = path.join(ctx.tmpDir, 'preview-staging');

  const { createUser } = await import('../db/users.js');
  ({ mintProxyToken } = await import('../services/mediaProxyToken.js'));
  ({ countCached } = await import('../db/previewCache.js'));
  ({ whenStoresSettle, byteCacheKey } = await import('../services/previewCache/index.js'));
  const router = (await import('./linkPreview.js')).default;

  const alice = createUser('alice-droppercache');
  app = createTestApp({ '/api/link-preview': router });
  agent = await createAuthedAgent(app, alice.id);

  origin = http.createServer((req, res) => {
    originHits++;
    handler(req, res);
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${(origin.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await stub.close();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
  dropper.closeAllConnections();
  await new Promise<void>((resolve) => dropper.close(() => resolve()));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('LURKER_PREVIEW_CACHE')) delete process.env[k];
  }
  ctx.cleanup();
});

beforeEach(async () => {
  // ⚠⚠ Drains BEFORE clearing — stores are fire-and-forget, so a write from the
  // previous test can still be in flight and land in this one's clean state.
  await whenStoresSettle();
  originHits = 0;
  stores = [];
  dropperRejects = false;
  dropperWrongLayout = false;
  const { default: db } = await import('../db/index.js');
  db.prepare('DELETE FROM preview_cache').run();
});

describe('the dropper byte cache, end to end', () => {
  it('POSTs the bytes to /api/previews with the key part FIRST, Bearer-keyed, and records a row', async () => {
    servePng();
    const first = await agent.get(`/api/link-preview/media/${tokenFor('/stored.png')}`);
    expect(first.status).toBe(200);
    expect(Buffer.from(first.body).equals(PNG)).toBe(true);
    await whenStoresSettle();

    expect(stores).toHaveLength(1);
    const store = stores[0]!;
    // ⚠ The METHOD and PATH are asserted — a stub that records everything cannot
    // tell you it was written to wrongly unless you ask.
    expect(store.method).toBe('POST');
    expect(store.url).toBe('/api/previews');
    expect(store.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(String(store.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    // Same protocol the upload driver speaks, down to the User-Agent — fleet
    // logs must be able to attribute preview traffic the way they do uploads.
    expect(String(store.headers['user-agent'])).toContain('Lurker');

    const raw = store.body.toString('latin1');
    const key = byteCacheKey(`${base}/stored.png`);
    // The key field, the file part, and the ordering rule: the text part must
    // arrive BEFORE the file so the dropper's parser has req.body.key populated.
    const keyAt = raw.indexOf('name="key"');
    const fileAt = raw.indexOf('name="file"');
    expect(keyAt).toBeGreaterThan(-1);
    expect(fileAt).toBeGreaterThan(-1);
    expect(keyAt).toBeLessThan(fileAt);
    expect(raw).toContain(key);
    expect(raw).toContain('Content-Type: image/png');
    expect(store.body.includes(PNG)).toBe(true);

    expect(countCached()).toBe(1);
  });

  it('mints the CDN URL in the descriptor once the object is stored', async () => {
    // ⚠⚠ THE HEADLINE PROPERTY OF THE MODE: a client is handed the public URL at
    // DESCRIPTOR-MINT time, so a cached image costs the cell nothing at all. The
    // URL is a pure function of config + key — the dropper's response body is
    // deliberately never consulted.
    servePng();
    const imageUrl = `${base}/minted.png`;

    const cold = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    expect(cold.status).toBe(200);
    expect(cold.body.previews[0].src).toMatch(/^\/api\/link-preview\/media\//);

    await agent.get(`/api/link-preview/media/${mintProxyToken(imageUrl)}`);
    await whenStoresSettle();
    expect(countCached()).toBe(1);

    const warm = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    expect(warm.status).toBe(200);
    expect(warm.body.previews[0].src).toBe(`${CDN}/${byteCacheKey(imageUrl)}`);
  });

  it('leaves NO ROW when the dropper refuses the store, and still serves the reader', async () => {
    // ⚠⚠ An index entry for an object that does not exist makes `publicByteUrl`
    // mint a public URL that 404s for everyone, with no request reaching the cell
    // to notice.
    dropperRejects = true;
    servePng();
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/denied.png')}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
    await whenStoresSettle();

    expect(stores.some((s) => s.method === 'POST')).toBe(true);
    expect(countCached()).toBe(0);
  });

  it('refuses to record a store whose answered URL disagrees with the minted layout', async () => {
    // ⚠⚠ The one misconfiguration the pure-function mint cannot see on its own:
    // a KEY_PREFIX on the dropper (or a wrong PUBLIC_BASE_URL here) makes every
    // store "succeed" while every minted URL 404s, with no request ever
    // reaching the cell. The dropper's answered URL is the free cross-check.
    const { resetWarnThrottleForTests } = await import('../services/previewCache/inflight.js');
    resetWarnThrottleForTests();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m) => void warns.push(String(m)));
    try {
      dropperWrongLayout = true;
      servePng();
      const res = await agent.get(`/api/link-preview/media/${tokenFor('/mislayout.png')}`);
      // The reader is still served; only the row is refused.
      expect(res.status).toBe(200);
      await whenStoresSettle();
      expect(stores.some((s) => s.method === 'POST')).toBe(true);
      expect(countCached()).toBe(0);
      expect(warns.some((w) => w.includes('layout mismatch'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves no staging file behind, whether the store lands or fails', async () => {
    const stagingDir = process.env.LURKER_PREVIEW_CACHE_DIR!;
    servePng();
    await agent.get(`/api/link-preview/media/${tokenFor('/kept.png')}`);
    await whenStoresSettle();

    dropperRejects = true;
    await agent.get(`/api/link-preview/media/${tokenFor('/dropped.png')}`);
    await whenStoresSettle();

    const stray = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : [];
    expect(stray).toEqual([]);
  });

  it('serves a proxy request for a stored object from the CDN, not the origin', async () => {
    // A client holding a descriptor minted before the store landed still arrives
    // at the proxy; that read should cost a CDN GET, not another third-party
    // fetch. The CDN is global fetch here (config rightly refuses an http public
    // base); the origin path uses node:http, so the spy sees only the cache read.
    servePng();
    const token = tokenFor('/reread.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(originHits).toBe(1);

    const key = byteCacheKey(`${base}/reread.png`);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toBe(`${CDN}/${key}`);
      return new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      });
    });
    try {
      const second = await agent.get(`/api/link-preview/media/${token}`);
      expect(second.status).toBe(200);
      expect(Buffer.from(second.body).equals(PNG)).toBe(true);
      // ⚠ THE assertion: one origin hit for two reads is the feature.
      expect(originHits).toBe(1);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('repairs the row and re-fetches when the lifecycle rule has taken the object', async () => {
    // ⚠⚠ The 30-day lifecycle rule deletes objects the cell does not run and
    // cannot observe; a proxy read is the only moment we ever learn one has gone
    // early, and a genuine 404 must forget the row rather than 404 forever. The
    // origin is taken away too, so the forget is the only thing that could have
    // emptied the table (see the s3 suite for why that matters).
    servePng();
    const token = tokenFor('/vanished.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(countCached()).toBe(1);

    handler = (_req, res) => res.writeHead(404).end();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('gone', { status: 404 }));
    try {
      const after = await agent.get(`/api/link-preview/media/${token}`);
      expect(after.status).toBe(404);
      expect(originHits).toBe(2);
      await whenStoresSettle();
      expect(countCached()).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }

    // ...and with a working origin it heals completely.
    servePng();
    const healed = await agent.get(`/api/link-preview/media/${token}`);
    expect(healed.status).toBe(200);
    await whenStoresSettle();
    expect(countCached()).toBe(1);
  });

  it('does not mint a CDN URL for a row past its age bound', async () => {
    // Twenty-five days against the bucket rule's thirty is the margin that makes
    // the row provably the shorter-lived of the two — same bound, same reasoning,
    // same test as s3, because the dropper's objects die by the same rule.
    servePng();
    const imageUrl = `${base}/ageing.png`;
    await agent.get(`/api/link-preview/media/${mintProxyToken(imageUrl)}`);
    await whenStoresSettle();

    const warm = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    expect(warm.body.previews[0].src).toBe(`${CDN}/${byteCacheKey(imageUrl)}`);

    const { default: db } = await import('../db/index.js');
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE preview_cache SET created_at = ?').run(old);

    const stale = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    expect(stale.body.previews[0].src).toMatch(/^\/api\/link-preview\/media\//);
  });

  it('stays a miss, not an error, when the dropper is unreachable', async () => {
    const { resetCacheConfigForTests } = await import('../services/previewCache/index.js');
    const realUrl = process.env.LURKER_PREVIEW_CACHE_DROPPER_URL!;
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));

    process.env.LURKER_PREVIEW_CACHE_DROPPER_URL = `http://127.0.0.1:${deadPort}`;
    resetCacheConfigForTests();
    try {
      servePng();
      const res = await agent.get(`/api/link-preview/media/${tokenFor('/nodropper.png')}`);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body).equals(PNG)).toBe(true);
      await whenStoresSettle();
      expect(countCached()).toBe(0);
    } finally {
      process.env.LURKER_PREVIEW_CACHE_DROPPER_URL = realUrl;
      resetCacheConfigForTests();
    }
  });

  it('does not cache a video, and sends nothing to the dropper for one', async () => {
    const MP4 = Buffer.alloc(2048, 7);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length) });
      res.end(MP4);
    };
    await agent.get(`/api/link-preview/media/${tokenFor('/clip.mp4')}`);
    await whenStoresSettle();
    expect(countCached()).toBe(0);
    expect(stores).toHaveLength(0);
  });
});

describe('resource bounds and diagnostics', () => {
  it('declines a store rather than queueing when too many are already in flight', async () => {
    // The ceiling lives in ./inflight.ts and is SHARED with the s3 backend — one
    // process, one set of outbound stores — so the seams are imported from there.
    const { openDropperWrite } = await import('../services/previewCache/dropper.js');
    const { storesInFlightForTests } = await import('../services/previewCache/inflight.js');
    const { cacheConfig } = await import('../services/previewCache/index.js');
    const cfg = cacheConfig();
    if (cfg.mode !== 'dropper') throw new Error('unreachable');

    // ⚠ Slots released in a FINALLY: the counter is module state with no reset
    // seam, so an assertion failure that skipped the aborts would pin the shared
    // ceiling at 16 and cascade into every later store test in this file.
    const opened = [];
    try {
      for (let i = 0; i < 16; i++) {
        const w = await openDropperWrite(cfg, `bound-${i}`);
        expect(`writer ${i}: ${w ? 'open' : 'refused'}`).toBe(`writer ${i}: open`);
        if (w) opened.push(w);
      }
      expect(storesInFlightForTests()).toBe(16);
      expect(await openDropperWrite(cfg, 'bound-over')).toBeNull();
    } finally {
      for (const w of opened) await w.abort();
    }
    expect(storesInFlightForTests()).toBe(0);
    const after = await openDropperWrite(cfg, 'bound-after');
    expect(after).not.toBeNull();
    await after!.abort();
  });

  it('readDropper declines a CDN read without a Content-Length, and only a 404 is "missing"', async () => {
    // Unit-level, with a hand-built plain-http config: readDropper takes the
    // config as a parameter, and the route-level config (rightly) refuses an
    // http public base. Same guards as readS3, asserted against the same traps:
    // `Number(null)` is 0, which is finite and under any cap.
    const { readDropper } = await import('../services/previewCache/dropper.js');

    let mode: 'ok' | 'no-length' | 'missing' | 'denied' | 'oversize' = 'ok';
    const cdn = http.createServer((_req, res) => {
      if (mode === 'missing') return void res.writeHead(404).end('no such key');
      if (mode === 'denied') return void res.writeHead(403).end('denied');
      if (mode === 'no-length') {
        res.writeHead(200, { 'content-type': 'image/png' });
        return void res.end(PNG);
      }
      if (mode === 'oversize') {
        // Headers promising far more than the cap, then silence — the client has
        // to walk away on the declared length, not read to find out.
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': '999999999' });
        return void res.flushHeaders();
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      res.end(PNG);
    });
    await new Promise<void>((r) => cdn.listen(0, '127.0.0.1', r));
    const cfg = {
      mode: 'dropper' as const,
      url: 'http://127.0.0.1:1',
      apiKey: 'k',
      publicBaseUrl: `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`,
      stagingDir: path.join(ctx.tmpDir, 'unit-staging'),
    };
    try {
      const ok = await readDropper(cfg, 'somekey', 1024 * 1024);
      expect(ok.kind === 'ok' && ok.body.equals(PNG)).toBe(true);

      mode = 'no-length';
      expect((await readDropper(cfg, 'somekey', 1024 * 1024)).kind).toBe('error');

      // ⚠⚠ GONE vs BROKEN: only a genuine 404 may forget an index row.
      mode = 'missing';
      expect((await readDropper(cfg, 'somekey', 1024 * 1024)).kind).toBe('missing');
      mode = 'denied';
      expect((await readDropper(cfg, 'somekey', 1024 * 1024)).kind).toBe('error');

      mode = 'oversize';
      const started = Date.now();
      const over = await readDropper(cfg, 'somekey', 1024 * 1024);
      expect(over.kind).toBe('error');
      // Cancelled on the declared length — reading the promised ~1 GB of silence
      // would block until the 30 s request timeout.
      expect(`${Date.now() - started < 3000 ? 'prompt' : 'blocked'}`).toBe('prompt');
    } finally {
      cdn.closeAllConnections();
      await new Promise<void>((r) => cdn.close(() => r()));
    }
  });

  it('sweeps rows left behind by a backend that is no longer configured', async () => {
    const { sweepPreviewCache } = await import('../services/previewCache/index.js');
    const { recordCached, countCached } = await import('../db/previewCache.js');

    recordCached({ key: 'leftover-s3', backend: 's3', contentType: 'image/png', size: 10 });
    recordCached({
      key: 'current-dropper',
      backend: 'dropper',
      contentType: 'image/png',
      size: 10,
    });
    expect(countCached()).toBe(2);

    await sweepPreviewCache();
    // The foreign row goes — and nothing was asked to DELETE any bytes: the cell
    // holds no delete capability, the lifecycle rule owns retention.
    expect(countCached()).toBe(1);
    expect(stores).toHaveLength(0);
  });

  it('says something when the dropper refuses every store, instead of failing silently', async () => {
    const { resetWarnThrottleForTests } = await import('../services/previewCache/inflight.js');
    resetWarnThrottleForTests();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m) => void warns.push(String(m)));
    try {
      dropperRejects = true;
      servePng();
      await agent.get(`/api/link-preview/media/${tokenFor('/loud.png')}`);
      await whenStoresSettle();
      expect(warns.some((w) => w.includes('[preview-cache]') && w.includes('500'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
