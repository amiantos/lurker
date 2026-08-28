// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The `s3` byte cache through the ROUTE, against a stub bucket that remembers
// what it was sent.
//
// ⚠⚠ THIS FILE IS THE PRICE OF ADMISSION FOR THE MODE. `s3` was built once
// before, bundled with `local`, and split back out because a review found that
// nearly every serious defect lived in the bucket half — the half with no
// route-level coverage. Bundled, the untested half hid behind the tested one, and
// its first real execution would have been against somebody's live R2.
//
// ⚠ What's mocked is the POLICY and the far end, never the mechanism: the address
// guard is inverted so a loopback origin is reachable, and the bucket is a stand-in
// http server. The SigV4 signing, the key layout, the staging file, the streamed
// PUT, the index write, the descriptor mint, Express, the token, the throttles, the
// pool and safeRequest are all shipping code.
//
// ⚠ The signature is asserted as a SCHEME, not recomputed. Reimplementing the
// calculation here would only test the test.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import { startStubDecoder, type StubDecoder } from '../test-utils/stubDecoder.js';

const ctx = setupTestDb('routes-link-preview-s3cache');

/** What the stub bucket recorded for one request. */
interface Put {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let puts: Put[] = [];
/** Objects the stub bucket is holding, by request path. */
let objects = new Map<string, { body: Buffer; contentType: string }>();
/** Flip to make every write fail, without changing anything else. */
let bucketRejects = false;
/** Flip to serve reads without a Content-Length, as a proxy in front of a bucket
 *  (or MinIO/Garage under some configurations) will. */
let bucketOmitsLength = false;
/** Flip to answer reads with headers promising a huge body, and then send nothing
 *  — a bucket or proxy that accepts the request and stalls. */
let bucketStallsAfterHeaders = false;

let bucket: http.Server;
let bucketBase: string;

const BUCKET_NAME = 'previews-bucket';
const PREFIX = 'previews';
const CDN = 'https://cdn.example.com';

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
  // The stub bucket. Started BEFORE the cache config is read, because the config
  // is resolved once per process and has to point at a real port.
  bucket = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      puts.push({ method: req.method || '', url: req.url || '', headers: req.headers, body });
      if (req.method === 'PUT') {
        if (bucketRejects) {
          res.writeHead(403).end('denied');
          return;
        }
        objects.set(req.url || '', {
          body,
          contentType: String(req.headers['content-type'] || ''),
        });
        res.writeHead(200).end();
        return;
      }
      if (req.method === 'GET') {
        if (bucketStallsAfterHeaders) {
          // Headers promising far more than the cap, then silence. Nothing ends
          // this response; the client has to decide to walk away.
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': '999999999' });
          // ⚠ FLUSHED. node holds headers until the first write or `end()`, so
          // without this the stub sends nothing at all — the client blocks waiting
          // for a status line and `fetch` never resolves, which is a different
          // stall from the one under test and would pass for the wrong reason.
          res.flushHeaders();
          return;
        }
        const held = objects.get(req.url || '');
        if (!held) {
          res.writeHead(404).end('no such key');
          return;
        }
        if (bucketOmitsLength) {
          // No content-length and no explicit framing → node sends it chunked.
          res.writeHead(200, { 'content-type': held.contentType });
          res.end(held.body);
          return;
        }
        res.writeHead(200, {
          'content-type': held.contentType,
          'content-length': String(held.body.length),
        });
        res.end(held.body);
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(req.url || '');
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', resolve));
  bucketBase = `http://127.0.0.1:${(bucket.address() as AddressInfo).port}`;

  process.env.LURKER_PREVIEW_CACHE_MODE = 's3';
  process.env.LURKER_PREVIEW_CACHE_S3_ENDPOINT = bucketBase;
  process.env.LURKER_PREVIEW_CACHE_S3_BUCKET = BUCKET_NAME;
  process.env.LURKER_PREVIEW_CACHE_S3_ACCESS_KEY_ID = 'test-key-id';
  process.env.LURKER_PREVIEW_CACHE_S3_SECRET_ACCESS_KEY = 'test-secret';
  process.env.LURKER_PREVIEW_CACHE_S3_PUBLIC_BASE_URL = CDN;
  process.env.LURKER_PREVIEW_CACHE_S3_PREFIX = PREFIX;
  process.env.LURKER_PREVIEW_CACHE_DIR = path.join(ctx.tmpDir, 'preview-staging');

  const { createUser } = await import('../db/users.js');
  ({ mintProxyToken } = await import('../services/mediaProxyToken.js'));
  ({ countCached } = await import('../db/previewCache.js'));
  ({ whenStoresSettle, byteCacheKey } = await import('../services/previewCache/index.js'));
  const router = (await import('./linkPreview.js')).default;

  const alice = createUser('alice-s3cache');
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
  // ⚠ Sockets first. A stalled response from the test below is still open, and
  // `close()` alone waits for it — the suite would hang on teardown rather than on
  // the assertion.
  bucket.closeAllConnections();
  await new Promise<void>((resolve) => bucket.close(() => resolve()));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('LURKER_PREVIEW_CACHE')) delete process.env[k];
  }
  ctx.cleanup();
});

beforeEach(async () => {
  // ⚠⚠ Drains BEFORE clearing, for the same reason the `local` suite does: stores
  // are fire-and-forget, so a write from the previous test can still be in flight
  // and land in this one's clean state, reading as "this test cached something".
  await whenStoresSettle();
  originHits = 0;
  puts = [];
  objects = new Map();
  bucketRejects = false;
  bucketOmitsLength = false;
  bucketStallsAfterHeaders = false;
  const { default: db } = await import('../db/index.js');
  db.prepare('DELETE FROM preview_cache').run();
});

/** The request path the stub bucket should have seen for one origin URL. */
const keyPathFor = (originPath: string): string =>
  `/${BUCKET_NAME}/${PREFIX}/${byteCacheKey(`${base}${originPath}`)}`;

/**
 * The bucket requests that actually WROTE.
 *
 * ⚠ `puts` records every method, and a store is no longer the first thing the stub
 * sees: `lookup` now probes the bucket before falling back to the origin, so an
 * uncached URL costs a GET (404) and then a PUT. Indexing `puts[0]` would silently
 * start asserting against the probe.
 */
const writes = (): Put[] => puts.filter((p) => p.method === 'PUT');

describe('the s3 byte cache, end to end', () => {
  it('PUTs the object to <bucket>/<prefix>/<key>, signed, and records it', async () => {
    servePng();
    const first = await agent.get(`/api/link-preview/media/${tokenFor('/stored.png')}`);
    expect(first.status).toBe(200);
    expect(Buffer.from(first.body).equals(PNG)).toBe(true);
    await whenStoresSettle();

    expect(writes()).toHaveLength(1);
    const put = writes()[0]!;
    // ⚠ The METHOD is asserted. The pre-split suite never did, so changing PUT to
    // POST passed all five of its tests — a stub that records everything cannot
    // tell you it was written to wrongly unless you ask.
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(keyPathFor('/stored.png'));
    expect(put.body.equals(PNG)).toBe(true);
    expect(String(put.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=test-key-id\//);
    expect(put.headers['content-type']).toBe('image/png');
    expect(countCached()).toBe(1);
  });

  it('stores the hardening headers object storage can actually replay', async () => {
    // ⚠⚠ A cached object is fetched DIRECTLY by the browser, so the only headers
    // it ever sees are the ones signed onto the object here — `applyMediaHeaders`
    // never runs for that request. Of the six the proxy sets, object storage will
    // store and replay exactly these; the other three are unavailable by
    // construction and are accounted for in previewCache/s3.ts.
    servePng();
    await agent.get(`/api/link-preview/media/${tokenFor('/headers.png')}`);
    await whenStoresSettle();

    const put = writes()[0]!;
    expect(put.headers['content-disposition']).toBe('inline');
    // ⚠ NOT the uploader's `public, max-age=31536000, immutable`. A URL-keyed cache
    // legitimately points at different bytes over time, and a year at the edge would
    // mean deleting an object could not un-serve it — the signer hardcoded that
    // value until this mode needed otherwise.
    expect(put.headers['cache-control']).toBe('public, max-age=86400');
    expect(put.headers['cache-control']).not.toMatch(/immutable/);
  });

  it('mints the CDN URL in the descriptor once the object is stored', async () => {
    // ⚠⚠ THE HEADLINE PROPERTY OF THE MODE, and the reason there is no redirect
    // anywhere in it. A client is handed the public URL at DESCRIPTOR-MINT time, so
    // a cached image costs the cell nothing at all — no bytes, and not even the
    // round trip a 302 would have spent to say so.
    servePng();
    const imageUrl = `${base}/minted.png`;

    // Before anything is cached, the descriptor points at the proxy — which is what
    // makes the first read possible at all.
    const cold = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    expect(cold.status).toBe(200);
    expect(cold.body.previews[0].src).toMatch(/^\/api\/link-preview\/media\//);

    // Populate the cache the only way it is ever populated: a real read through the
    // proxy.
    await agent.get(`/api/link-preview/media/${mintProxyToken(imageUrl)}`);
    await whenStoresSettle();
    expect(countCached()).toBe(1);

    const warm = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    expect(warm.status).toBe(200);
    expect(warm.body.previews[0].src).toBe(`${CDN}/${PREFIX}/${byteCacheKey(imageUrl)}`);
  });

  it('leaves NO ROW when the bucket refuses the write', async () => {
    // ⚠⚠ The guard worth having, and the one that turns a cache miss into a
    // permanently broken image. An index entry for an object that does not exist
    // makes `publicByteUrl` mint a public URL that 404s — for everyone, with no
    // request reaching the cell to notice, for as long as the row lives.
    // Revert-proven: deleting the status check in openS3Write takes this red.
    bucketRejects = true;
    servePng();
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/denied.png')}`);
    // ⚠ The READER is still served. A cache is an optimisation over a feature that
    // already works, so a bucket failure must never reach the person asking.
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
    await whenStoresSettle();

    expect(puts.some((p) => p.method === 'PUT')).toBe(true);
    expect(countCached()).toBe(0);
  });

  it('leaves no staging file behind, whether the write lands or fails', async () => {
    // ⚠ The staging file is invisible to the index and to eviction, so a leak here
    // is bytes on the volume nothing can find — and unlike `local`'s temp files it
    // has no shard directory anyone would think to look in.
    const stagingDir = process.env.LURKER_PREVIEW_CACHE_DIR!;
    servePng();
    await agent.get(`/api/link-preview/media/${tokenFor('/kept.png')}`);
    await whenStoresSettle();

    bucketRejects = true;
    await agent.get(`/api/link-preview/media/${tokenFor('/dropped.png')}`);
    await whenStoresSettle();

    const stray = fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : [];
    expect(stray).toEqual([]);
  });

  it('serves a proxy request for a stored object from the BUCKET, not the origin', async () => {
    // A client holding a descriptor minted before the store landed still arrives at
    // the proxy. That read should cost a bucket GET, not another third-party fetch.
    servePng();
    const token = tokenFor('/reread.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(originHits).toBe(1);

    const second = await agent.get(`/api/link-preview/media/${token}`);
    expect(second.status).toBe(200);
    expect(Buffer.from(second.body).equals(PNG)).toBe(true);
    // ⚠ THE assertion. Same bytes proves nothing on its own — the uncached path
    // returns those too. One origin hit for two reads is the feature.
    expect(originHits).toBe(1);
    expect(puts.some((p) => p.method === 'GET')).toBe(true);
  });

  it('repairs the row and re-fetches when the object has been deleted from the bucket', async () => {
    // ⚠⚠ Finding 1, in the one place it can still be caught. A 30-day lifecycle rule
    // deletes objects the cell does not run and cannot observe; the age bound is the
    // primary defence, but a proxy read is the only moment we ever learn an object
    // has gone early. A 404 must forget the row rather than 404 forever.
    servePng();
    const token = tokenFor('/vanished.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(countCached()).toBe(1);

    objects.clear(); // the lifecycle rule, or a human with the console open

    // ⚠⚠ The origin is taken away too, and that is what makes this test BITE. With
    // the origin still healthy the row is rewritten by the re-store on the way out,
    // so "the row was forgotten" and "the row was never forgotten" look identical
    // from here — the first draft of this test passed with the 404 branch reporting
    // a plain error, which is precisely the bug it is supposed to catch. Denying the
    // re-store leaves the forget as the only thing that could have emptied the table.
    handler = (_req, res) => res.writeHead(404).end();

    const after = await agent.get(`/api/link-preview/media/${token}`);
    expect(after.status).toBe(404);
    expect(originHits).toBe(2);
    await whenStoresSettle();
    expect(countCached()).toBe(0);

    // ...and with a working origin it heals completely.
    servePng();
    const healed = await agent.get(`/api/link-preview/media/${token}`);
    expect(healed.status).toBe(200);
    expect(Buffer.from(healed.body).equals(PNG)).toBe(true);
    await whenStoresSettle();
    expect(countCached()).toBe(1);
  });

  it('does not mint a CDN URL for a row past its age bound', async () => {
    // ⚠⚠ The primary defence for finding 1, and the only one that works without a
    // request reaching us. Objects are deleted by a 30-day bucket lifecycle rule the
    // cell does not run and cannot observe, so a row that outlived its object would
    // have the descriptor handing every user a public URL that 404s — with nothing
    // arriving at the cell to notice. Seven days against thirty is the margin that
    // makes the row provably the shorter-lived of the two.
    servePng();
    const imageUrl = `${base}/ageing.png`;
    await agent.get(`/api/link-preview/media/${mintProxyToken(imageUrl)}`);
    await whenStoresSettle();

    const warm = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    expect(warm.body.previews[0].src).toBe(`${CDN}/${PREFIX}/${byteCacheKey(imageUrl)}`);

    // Age the row past the bound. Eight days: the bound is seven.
    const { default: db } = await import('../db/index.js');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE preview_cache SET created_at = ?').run(old);

    const stale = await agent.post('/api/link-preview/resolve').send({ urls: [imageUrl] });
    // ⚠ Back to the PROXY, not to a broken CDN URL. Falling back is always safe;
    // minting for an object that may be gone is the one thing that cannot self-heal.
    expect(stale.body.previews[0].src).toMatch(/^\/api\/link-preview\/media\//);
  });

  it('stays a miss, not an error, when the bucket is unreachable', async () => {
    // A cache is an optimisation over a feature that already works, so an
    // unreachable bucket has to degrade to the uncached path rather than to a 500.
    const { resetCacheConfigForTests } = await import('../services/previewCache/index.js');
    const realEndpoint = process.env.LURKER_PREVIEW_CACHE_S3_ENDPOINT!;
    // A port nothing is listening on. Reserved-but-closed beats a bogus host, which
    // would test DNS failure instead.
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));

    process.env.LURKER_PREVIEW_CACHE_S3_ENDPOINT = `http://127.0.0.1:${deadPort}`;
    resetCacheConfigForTests();
    try {
      servePng();
      const res = await agent.get(`/api/link-preview/media/${tokenFor('/nobucket.png')}`);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body).equals(PNG)).toBe(true);
      await whenStoresSettle();
      expect(countCached()).toBe(0);
    } finally {
      process.env.LURKER_PREVIEW_CACHE_S3_ENDPOINT = realEndpoint;
      resetCacheConfigForTests();
    }
  });

  it('does not cache a video, and mints no CDN URL for one', async () => {
    const MP4 = Buffer.alloc(2048, 7);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MP4.length) });
      res.end(MP4);
    };
    const token = tokenFor('/clip.mp4');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(countCached()).toBe(0);
    expect(puts.some((p) => p.method === 'PUT')).toBe(false);
  });
});

describe('resource bounds and diagnostics', () => {
  it('declines a store rather than queueing when too many are already in flight', async () => {
    // ⚠⚠ `mediaPool`'s 24 slots do NOT cover this. The route calls `commit` without
    // awaiting — so a slow bucket cannot hold a reader's response open — and gives
    // its pool slot back on the response's `close` at the same moment. The hash and
    // the PUT therefore run outside the pool for up to 60 s, each pinning a staged
    // file and a socket. One session at the route's own rate limit would otherwise
    // accumulate hundreds of both.
    const { openS3Write, storesInFlightForTests } = await import('../services/previewCache/s3.js');
    const { cacheConfig } = await import('../services/previewCache/index.js');
    const cfg = cacheConfig();
    if (cfg.mode !== 's3') throw new Error('unreachable');

    // ⚠ Slots released in a FINALLY: the counter is module state with no reset
    // seam, so an assertion failure that skipped the aborts would pin the shared
    // ceiling at 16 and cascade into every later store test in this file.
    const opened = [];
    try {
      for (let i = 0; i < 16; i++) {
        const w = await openS3Write(cfg, `bound-${i}`);
        expect(`writer ${i}: ${w ? 'open' : 'refused'}`).toBe(`writer ${i}: open`);
        if (w) opened.push(w);
      }
      expect(storesInFlightForTests()).toBe(16);
      // ⚠ The 17th is REFUSED, not queued — a queue would bound sockets and not files.
      expect(await openS3Write(cfg, 'bound-over')).toBeNull();
    } finally {
      // ...and the ceiling is released, not leaked, so the next request can store.
      for (const w of opened) await w.abort();
    }
    expect(storesInFlightForTests()).toBe(0);
    const after = await openS3Write(cfg, 'bound-after');
    expect(after).not.toBeNull();
    await after!.abort();
  });

  it('declines a bucket read that arrives without a Content-Length', async () => {
    // ⚠⚠ `headers.get()` answers null when the header is absent and `Number(null)`
    // is 0 — finite, and under any cap. So a `Number.isFinite` test alone waves
    // through exactly the responses it cannot bound, and `arrayBuffer()` pulls the
    // whole body into the heap inside a `mediaPool` slot. Declining costs a
    // re-fetch, which is what a cache miss already is.
    servePng();
    const token = tokenFor('/unframed-read.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(originHits).toBe(1);

    bucketOmitsLength = true;
    const after = await agent.get(`/api/link-preview/media/${token}`);
    expect(after.status).toBe(200);
    expect(Buffer.from(after.body).equals(PNG)).toBe(true);
    // ⚠ THE assertion: the bucket read was declined, so the ORIGIN was asked again.
    // Without the guard this is 1 — served from a body nothing had bounded.
    expect(originHits).toBe(2);
  });

  it('walks away from an over-cap body instead of reading it to discard it', async () => {
    // ⚠⚠ `res.text()` was being used to "drain" these responses so undici would
    // release the socket. It does release it — by BUFFERING THE WHOLE BODY, which in
    // this branch is the exact thing the size guard just refused. The guard
    // announced the body was too big to hold and then held it. (Copilot.)
    //
    // ⚠ THE ASSERTION IS THE CLOCK, and it is what makes this deterministic rather
    // than a memory measurement. The stub sends headers promising ~1 GB and then
    // sends nothing at all: cancelling the body returns at once, while reading it
    // blocks until the 30 s request timeout — well past vitest's 5 s default, so the
    // old behaviour fails rather than merely being slower.
    servePng();
    const token = tokenFor('/stalling-bucket.png');
    await agent.get(`/api/link-preview/media/${token}`);
    await whenStoresSettle();
    expect(originHits).toBe(1);

    bucketStallsAfterHeaders = true;
    const started = Date.now();
    const after = await agent.get(`/api/link-preview/media/${token}`);
    const elapsed = Date.now() - started;

    // The reader is still served — from the origin, because the bucket read was
    // declined rather than waited on.
    expect(after.status).toBe(200);
    expect(Buffer.from(after.body).equals(PNG)).toBe(true);
    expect(originHits).toBe(2);
    expect(`${elapsed < 3000 ? 'prompt' : 'blocked'}`).toBe('prompt');
  });

  it('sweeps rows left behind by a backend that is no longer configured', async () => {
    // ⚠ `lookup` forgets a foreign row only if a request asks for that exact key,
    // and after a mode switch nothing ever does — the descriptor never mints for a
    // backend that is not current. Without this the table keeps rows for bytes that
    // are unreachable by construction, for the life of the instance.
    const { sweepPreviewCache } = await import('../services/previewCache/index.js');
    const { recordCached, countCached } = await import('../db/previewCache.js');

    recordCached({ key: 'leftover-local', backend: 'local', contentType: 'image/png', size: 10 });
    recordCached({ key: 'current-s3', backend: 's3', contentType: 'image/png', size: 10 });
    expect(countCached()).toBe(2);

    await sweepPreviewCache();
    // The foreign row goes; the current backend's fresh row stays.
    expect(countCached()).toBe(1);
  });

  it('says something when the bucket refuses every store, instead of failing silently', async () => {
    // ⚠ Config validation proves the five env vars are PRESENT, nothing more. A
    // wrong secret, a policy denial or a typo'd bucket name all resolve to a
    // working-looking `s3` mode where every store fails and nothing is ever logged —
    // an operator with no thread to pull. "Never a failure path" is about not
    // breaking the request, not about staying silent.
    const { resetWarnThrottleForTests } = await import('../services/previewCache/s3.js');
    // ⚠ The throttle is global and a minute long, so an earlier test in this file
    // silences this one. That is the throttle working — an operator whose bucket is
    // misconfigured wants one line a minute, not one per image — but it makes the
    // assertion order-dependent unless the window is cleared first. Found by this
    // test failing for exactly that reason.
    resetWarnThrottleForTests();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m) => void warns.push(String(m)));
    try {
      bucketRejects = true;
      servePng();
      await agent.get(`/api/link-preview/media/${tokenFor('/loud.png')}`);
      await whenStoresSettle();
      expect(warns.some((w) => w.includes('[preview-cache]') && w.includes('403'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * ⚠⚠ The state this whole group is about: an object in the bucket that the index
 * cannot name. It is not an edge case — it is the ORDINARY state of every object
 * between the row's age bound (7 d) and the bucket's lifecycle rule (30 d), and of
 * every object on every cell that did not personally store it. lurker#776.
 */
describe('finding cached bytes the index cannot name', () => {
  it('serves an object whose row has aged out, without going back to the origin', async () => {
    servePng();
    expect((await agent.get(`/api/link-preview/media/${tokenFor('/aged.png')}`)).status).toBe(200);
    await whenStoresSettle();
    expect(countCached()).toBe(1);
    const settled = originHits;

    // Age the ROW only. The object is deliberately left where it is — that
    // asymmetry is the bug: `MAX_AGE_MS` is 7 days precisely so the row is
    // provably shorter-lived than the object, and we then treated the row's
    // expiry as proof the object was gone.
    const { default: db } = await import('../db/index.js');
    db.prepare(
      `UPDATE preview_cache SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')`,
    ).run();

    const again = await agent.get(`/api/link-preview/media/${tokenFor('/aged.png')}`);
    expect(again.status).toBe(200);
    expect(Buffer.from(again.body).equals(PNG)).toBe(true);
    // ⚠⚠ THE POINT. Measured on app.lurker.chat as a byte-identical re-upload of a
    // GitHub og:image 18 days after it was first stored — and a permanently broken
    // card whenever the origin refused that pointless re-fetch.
    expect(originHits).toBe(settled);
  });

  it('serves an object another cell stored, for which this cell has no row at all', async () => {
    // The fleet shares one bucket but every cell keeps its own SQLite index, so
    // "no row, object present" is the normal state for every cell that did not do
    // the storing. Before this the shared bucket deduplicated writes and shared
    // nothing on reads: each cell paid its own origin fetch for every image.
    objects.set(keyPathFor('/foreign.png'), { body: PNG, contentType: 'image/png' });
    expect(countCached()).toBe(0);
    servePng();
    const before = originHits;

    const res = await agent.get(`/api/link-preview/media/${tokenFor('/foreign.png')}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
    expect(originHits).toBe(before);
  });

  it('does NOT record a row for a cold hit', async () => {
    objects.set(keyPathFor('/norow.png'), { body: PNG, contentType: 'image/png' });
    expect((await agent.get(`/api/link-preview/media/${tokenFor('/norow.png')}`)).status).toBe(200);
    await whenStoresSettle();
    // ⚠⚠ `recordCached` stamps `created_at` with NOW, and a cold read does not know
    // the object's real age. A day-25 object would get a row expiring at day 32 —
    // past the lifecycle deletion — and `publicByteUrl` would then mint a public URL
    // that 404s for every viewer with no request reaching us to notice. Serving the
    // bytes needs no row; minting a URL for them does.
    expect(countCached()).toBe(0);
  });

  it('falls through to the origin when the bucket really does not have it', async () => {
    servePng();
    const before = originHits;
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/absent.png')}`);
    expect(res.status).toBe(200);
    // A genuine 404 is the ONLY thing that means gone, and it still costs exactly
    // one origin fetch — the probe must not turn a miss into two.
    expect(originHits).toBe(before + 1);
  });

  it('refuses cold bytes that are not an image, however the object is labelled', async () => {
    // ⚠⚠ With no row to vouch for them the stored Content-Type is a CLAIM by
    // whatever wrote the key, and there is no recorded size to cross-check against
    // either — so the signature is the whole of the evidence. The store path gates
    // on it for the same reason; this is the same gate on the way back out.
    objects.set(keyPathFor('/liar.png'), {
      body: Buffer.from('<!doctype html><script>alert(1)</script>'),
      contentType: 'image/png',
    });
    servePng();
    const before = originHits;

    const res = await agent.get(`/api/link-preview/media/${tokenFor('/liar.png')}`);
    // Refused as a hit, so the origin answers — and what the client gets is the
    // origin's PNG, never the bucket's HTML.
    expect(originHits).toBe(before + 1);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
  });
});

/**
 * ⚠⚠ A 200 carrying real image bytes is not permission to KEEP them. GitHub's og:image
 * service answers a card it could not render with a 200 and a valid PNG — the dark
 * Octocat placeholder — marked `cache-control: public, max-age=0`, while a card it DID
 * render comes back `max-age=21600, immutable`. The bytes are indistinguishable; the
 * header is the whole of the difference, and nothing on either side of the seam read it.
 */
describe('the origin’s own caching instruction', () => {
  /** An origin that serves `body` with an explicit Cache-Control. */
  const serveWith = (cacheControl: string, body = PNG): void => {
    handler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(body.length),
        'cache-control': cacheControl,
      });
      res.end(body);
    };
  };

  it('serves but does not store a placeholder the origin marked max-age=0', async () => {
    serveWith('public, max-age=0');
    const res = await agent.get(`/api/link-preview/media/${tokenFor('/placeholder.png')}`);
    // ⚠ SERVED — refusing to keep it is not refusing to show it. The reader still gets
    // whatever the origin sent; we simply do not hold it for a week afterwards.
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);

    await whenStoresSettle();
    expect(writes()).toHaveLength(0);
    expect(countCached()).toBe(0);
  });

  it.each(['no-store', 'no-cache', 'private, max-age=600'])(
    'does not store under %s',
    async (cc) => {
      serveWith(cc);
      await agent.get(`/api/link-preview/media/${tokenFor(`/${cc.replace(/\W/g, '')}.png`)}`);
      await whenStoresSettle();
      expect(countCached()).toBe(0);
    },
  );

  it('still stores what the origin says is cacheable', async () => {
    // ⚠ The positive control, and it is the half that matters most: a guard that refuses
    // everything passes every test above while quietly turning the cache off.
    serveWith('public, max-age=21600, immutable');
    expect((await agent.get(`/api/link-preview/media/${tokenFor('/real.png')}`)).status).toBe(200);
    await whenStoresSettle();
    expect(writes()).toHaveLength(1);
    expect(countCached()).toBe(1);
  });

  it('still stores when the origin says nothing at all', async () => {
    // ⚠ Silence is permission. Plenty of image hosts send no Cache-Control, and treating
    // absence as prohibition would switch the cache off for most of the web.
    servePng();
    expect((await agent.get(`/api/link-preview/media/${tokenFor('/silent.png')}`)).status).toBe(
      200,
    );
    await whenStoresSettle();
    expect(countCached()).toBe(1);
  });
});
