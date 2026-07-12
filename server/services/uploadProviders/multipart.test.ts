// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Real sockets, real temp files. The driver tests stub multipart.postMultipart to
// assert what each provider ASKS for; this file asserts that the asking actually
// works — and, crucially, that it streams.
//
// The streaming test is the regression guard for #543. Every other test in the
// repo passes just as happily if someone rewrites postMultipart on top of fetch —
// and the upload path silently goes back to holding the whole file in memory
// (5x the file size, as shipped). This one fails.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { postMultipart, putSource, isOk } from './multipart.js';
import { bufferSource, fileSource } from './source.js';

// Force a GC on demand without needing `node --expose-gc` on the test runner:
// live `arrayBuffers` is only meaningful after collection, otherwise it counts
// dead chunks and a streaming upload looks identical to a buffering one.
v8.setFlagsFromString('--expose-gc');
const forceGc = vm.runInNewContext('gc') as () => void;

interface Received {
  contentLength?: string;
  transferEncoding?: string;
  contentType?: string;
  body: Buffer;
  bytes: number;
}

let server: Server;
let base: string;
let last: Received;
let throttleBytesPerTick = 0; // 0 = read as fast as possible
let keepBody = true;
let respondWith: { status: number; text: string } = { status: 200, text: 'ok' };
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-multipart-'));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const record = (c: Buffer) => {
      bytes += c.length;
      if (keepBody) chunks.push(c);
    };
    if (throttleBytesPerTick > 0) {
      let budget = throttleBytesPerTick;
      const grant = setInterval(() => {
        budget = throttleBytesPerTick;
        req.resume();
      }, 50);
      req.on('data', (c: Buffer) => {
        record(c);
        budget -= c.length;
        if (budget <= 0) req.pause();
      });
      req.on('end', () => clearInterval(grant));
    } else {
      req.on('data', record);
    }
    req.on('end', () => {
      last = {
        contentLength: req.headers['content-length'],
        transferEncoding: req.headers['transfer-encoding'],
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks),
        bytes,
      };
      res.writeHead(respondWith.status, { 'content-type': 'text/plain' });
      res.end(respondWith.text);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTemp(name: string, contents: Buffer): { path: string; size: number } {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, contents);
  return { path: p, size: contents.length };
}

describe('postMultipart', () => {
  it('streams a file source with an exact Content-Length and no chunked encoding', async () => {
    // Both properties matter: catbox's PHP backend stalls on chunked transfer
    // encoding (the original reason this module exists), so streaming must NOT
    // cost us the Content-Length.
    const bytes = Buffer.alloc(200_000, 0xab);
    const f = writeTemp('a.bin', bytes);
    respondWith = { status: 200, text: 'https://example.test/a' };
    keepBody = true;

    const resp = await postMultipart(base, [
      { name: 'reqtype', value: 'fileupload' },
      {
        name: 'fileToUpload',
        filename: 'a.bin',
        contentType: 'image/png',
        source: fileSource(f.path, f.size),
      },
    ]);

    expect(isOk(resp)).toBe(true);
    expect(resp.text).toBe('https://example.test/a');
    expect(last.transferEncoding).toBeUndefined();
    expect(Number(last.contentLength)).toBe(last.bytes);
    expect(last.contentType).toMatch(/^multipart\/form-data; boundary=/);

    // The parts arrived intact and in order, and the file bytes round-tripped.
    const text = last.body.toString('binary');
    expect(text).toContain('name="reqtype"');
    expect(text).toContain('fileupload');
    expect(text).toContain('name="fileToUpload"; filename="a.bin"');
    expect(text).toContain('Content-Type: image/png');
    expect(last.body.includes(bytes)).toBe(true);
  });

  it('sends a buffer source identically (the optimized-image path)', async () => {
    const bytes = Buffer.from('hello buffer source');
    respondWith = { status: 200, text: 'ok' };
    keepBody = true;

    await postMultipart(base, [
      { name: 'file', filename: 'x.txt', contentType: 'text/plain', source: bufferSource(bytes) },
    ]);

    expect(Number(last.contentLength)).toBe(last.bytes);
    expect(last.transferEncoding).toBeUndefined();
    expect(last.body.includes(bytes)).toBe(true);
  });

  it('surfaces a non-2xx as a status, and a dead socket as a rejection', async () => {
    respondWith = { status: 413, text: 'too big' };
    const resp = await postMultipart(base, [{ name: 'a', value: 'b' }]);
    expect(isOk(resp)).toBe(false);
    expect(resp.status).toBe(413);
    expect(resp.text).toBe('too big');

    await expect(
      postMultipart('http://127.0.0.1:1/', [{ name: 'a', value: 'b' }]),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  // ── The one that defends the PR ───────────────────────────────────────────────
  // A 64 MB file through a throttled sink. Streaming keeps only the pipe's queue
  // live (single-digit MB, independent of file size); anything that buffers the
  // body — which is EVERY fetch/undici body shape, measured — holds ~1x the file
  // (and the pre-#543 Blob path held 5x). The gap is enormous, so the threshold
  // can be generous and still catch a regression.
  it('holds constant memory: a large file is streamed, never buffered', async () => {
    const FILE_MB = 96;
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < chunk.length; i++) chunk[i] = i & 0xff;
    const p = path.join(tmpDir, 'big.bin');
    fs.writeFileSync(p, Buffer.alloc(0));
    for (let i = 0; i < FILE_MB; i++) fs.appendFileSync(p, chunk);
    const size = fs.statSync(p).size;

    // Throttle the sink and drop the body, so what we measure is the CLIENT's
    // retained memory while the upload is genuinely in flight.
    throttleBytesPerTick = 8 * 1024 * 1024;
    keepBody = false;
    respondWith = { status: 200, text: 'ok' };

    forceGc();
    const baseline = process.memoryUsage().arrayBuffers;
    let peakLive = baseline;
    const sampler = setInterval(() => {
      forceGc(); // collect first, THEN read: we want live bytes, not churn
      const live = process.memoryUsage().arrayBuffers;
      if (live > peakLive) peakLive = live;
    }, 30);

    try {
      const resp = await postMultipart(base, [
        {
          name: 'file',
          filename: 'big.bin',
          contentType: 'application/octet-stream',
          source: fileSource(p, size),
        },
      ]);
      expect(isOk(resp)).toBe(true);
    } finally {
      clearInterval(sampler);
      throttleBytesPerTick = 0;
      keepBody = true;
      fs.unlinkSync(p);
    }

    expect(last.bytes).toBeGreaterThan(size); // the whole file plus part headers
    const liveMb = (peakLive - baseline) / 1024 / 1024;
    // What stays live while streaming is the pipe's queue, which is bounded and
    // does NOT grow with the file (a 300 MB upload measured 7.6 MB live). Buffering
    // holds at least the whole file. So the bar is a constant, comfortably above
    // the observed queue depth (~16 MB under full-suite load) and far below 96 MB.
    expect(liveMb).toBeLessThan(32);
  });
});

describe('putSource', () => {
  it('PUTs a file source with an exact Content-Length (the s3 object path)', async () => {
    const bytes = Buffer.alloc(64_000, 0x5a);
    const f = writeTemp('obj.bin', bytes);
    respondWith = { status: 200, text: '' };
    keepBody = true;

    const resp = await putSource(base, fileSource(f.path, f.size), {
      headers: { 'content-type': 'image/png' },
    });

    expect(isOk(resp)).toBe(true);
    // A raw PUT body is the object itself — no multipart framing, exact length.
    expect(Number(last.contentLength)).toBe(size(bytes));
    expect(last.transferEncoding).toBeUndefined();
    expect(last.body.equals(bytes)).toBe(true);
  });
});

function size(b: Buffer): number {
  return b.length;
}
