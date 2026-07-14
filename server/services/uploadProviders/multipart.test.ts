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

  // #545: the byte count that drives the client's "Sending… NN%" for the slow half of
  // an upload. Asserted against a REAL socket (this suite's http server), because the
  // whole claim is that a yielded-and-resumed chunk is a chunk the socket took — that
  // is a property of the transport, not of the generator, and a fake would assume it.
  it('reports send progress that ends at exactly Content-Length', async () => {
    const bytes = Buffer.alloc(300_000, 0xcd);
    const f = writeTemp('prog.bin', bytes);
    respondWith = { status: 200, text: 'ok' };

    const seen: Array<{ sent: number; total: number }> = [];
    const resp = await postMultipart(
      base,
      [
        {
          name: 'file',
          filename: 'prog.bin',
          contentType: 'image/png',
          source: fileSource(f.path, f.size),
        },
      ],
      { onProgress: (sent, total) => seen.push({ sent, total }) },
    );
    expect(isOk(resp)).toBe(true);

    // It actually streamed — a single 0→100 jump would mean the body was buffered
    // whole, which is the memory blowup #543 removed.
    expect(seen.length).toBeGreaterThan(1);
    // Monotonic, and it lands on the exact total the server received. A count that
    // overshoots or stops short is a bar that ends at 103% or stalls at 98%.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].sent).toBeGreaterThan(seen[i - 1].sent);
    }
    const total = seen[0].total;
    expect(seen.at(-1)!.sent).toBe(total);
    expect(total).toBe(Number(last.contentLength));
    // Every part of the body counts, not just the file: Content-Length covers the
    // headers and boundaries too, so counting only file bytes would never reach 100%.
    expect(total).toBeGreaterThan(bytes.length);
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

  // A provider rejecting an oversized upload is the most common error there is, and
  // it arrives while we are still sending. There are two shapes of it, and they have
  // genuinely different outcomes — the first version of this test asserted only the
  // happy one and flaked ~1 run in 6, which is how the distinction got found.

  it('surfaces the provider’s 413 when it rejects early but keeps draining', async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x11);
    const f = writeTemp('rejected.bin', bytes);

    // A well-behaved server: answer immediately, but keep reading the body so the
    // client's writes never fail. The response is reliably delivered.
    //
    // This only holds because we no longer send `Connection: close`: a server told
    // to close destroys the socket as soon as it has written its answer, draining
    // or not, and the 413 dies with it (~30% of the time on a body this size). So
    // this test doubles as the guard on that — bring the header back and it flakes.
    const polite = createServer((req, res) => {
      req.once('data', () => {
        res.writeHead(413, { 'content-type': 'text/plain' });
        res.end('Files larger than 200MB are not allowed.');
      });
      req.resume(); // drain
    });
    await new Promise<void>((r) => polite.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(polite.address() as AddressInfo).port}/`;

    try {
      const resp = await postMultipart(url, [
        {
          name: 'fileToUpload',
          filename: 'rejected.bin',
          contentType: 'application/octet-stream',
          source: fileSource(f.path, f.size),
        },
      ]);
      expect(resp.status).toBe(413);
      expect(resp.text).toContain('Files larger than 200MB');
    } finally {
      polite.close();
    }
  });

  // …and the shape we CANNOT rescue. When the peer hangs up abruptly, node's socket
  // takes the EPIPE and destroys itself, discarding the response bytes already in
  // the receive buffer — the same reason an nginx client_max_body_size rejection so
  // often reaches a client as "connection reset" rather than the 413 it sent. We
  // can't recover the answer, so the contract is: never leak a bare `write EPIPE`,
  // always name the likely cause.
  it('explains a mid-upload hangup instead of surfacing a raw socket errno', async () => {
    const bytes = Buffer.alloc(24 * 1024 * 1024, 0x11);
    const f = writeTemp('hangup.bin', bytes);

    const rude = createServer((req, res) => {
      req.once('data', () => {
        res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
        res.end('too big');
        req.socket.destroy(); // abrupt: the response may never be parsed
      });
    });
    await new Promise<void>((r) => rude.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(rude.address() as AddressInfo).port}/`;

    try {
      // BOTH outcomes are legitimate and which one you get is a matter of whether
      // the parser got to the response before the socket died. What must never
      // happen is an unexplained errno reaching the user — so collapse the two into
      // one description and assert on that, rather than branching the assertions.
      const outcome = await postMultipart(url, [
        {
          name: 'fileToUpload',
          filename: 'hangup.bin',
          contentType: 'application/octet-stream',
          source: fileSource(f.path, f.size),
        },
      ]).then(
        (r) => `status ${r.status}`,
        (e: Error) => e.message,
      );

      expect(outcome).toMatch(
        /^status 413$|closed the connection while the file was still uploading/,
      );
    } finally {
      rude.close();
    }
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
