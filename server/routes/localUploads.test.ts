// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { bufferSource } from '../services/uploadProviders/source.js';
import { createTestApp, createAnonAgent } from '../test-utils/testApp.js';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import * as local from '../services/uploadProviders/local.js';

let dir: string;
let app: Express;
let agent: LurkerTestAgent;
const prevEnv = process.env.LOCAL_UPLOADS_DIR;

// Write a buffer through the real driver and return the served path.
async function put(buffer: Buffer, filename: string, mime: string): Promise<string> {
  const res = await local.upload(bufferSource(buffer), { filename, mime }, {});
  return res.url; // /uploads/local/<key>
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-localserve-'));
  process.env.LOCAL_UPLOADS_DIR = dir;
  const router = (await import('./localUploads.js')).default;
  app = createTestApp({ '/uploads/local': router });
  agent = createAnonAgent(app);
});

afterAll(() => {
  if (prevEnv == null) delete process.env.LOCAL_UPLOADS_DIR;
  else process.env.LOCAL_UPLOADS_DIR = prevEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /uploads/local/:key', () => {
  it('serves a recognized image inline with hardened headers', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 128, b: 255 } },
    })
      .png()
      .toBuffer();
    const url = await put(png, 'pic.png', 'image/png');

    const res = await agent.get(url);
    expect(res.status).toBe(200);
    // Content-Type comes from the sniffed magic bytes, not any stored claim.
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('honors a Range request with 206 partial content (via res.sendFile)', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const url = await put(png, 'range.png', 'image/png');

    const res = await agent.get(url).set('Range', 'bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toMatch(/^bytes 0-3\//);
    expect(res.headers['accept-ranges']).toBe('bytes');
    // The sniffed type still wins over sendFile's extension guess.
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('serves plain text inline as text/plain', async () => {
    const url = await put(Buffer.from('just some notes\nsecond line'), 'note.txt', 'text/plain');
    const res = await agent.get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('inline');
  });

  it('forces download for a recognized non-inline type (pdf)', async () => {
    // Minimal PDF header — file-type recognizes application/pdf, which is not on
    // the inline allowlist, so it must be served as an attachment.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
    const url = await put(pdf, 'doc.pdf', 'application/pdf');
    const res = await agent.get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves HTML as inert text/plain source, never executable', async () => {
    // HTML is valid UTF-8 → sniffs to text/plain (never text/html), and nosniff
    // stops the browser from re-sniffing it into an executable document.
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const url = await put(html, 'evil.html', 'text/html');
    const res = await agent.get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves text inline even when a multibyte char straddles the sniff window', async () => {
    // 4099 ASCII bytes + a 3-byte '€' (E2 82 AC): byte 4100 (the sniff cutoff)
    // lands mid-character. Without trimming the partial sequence, the UTF-8 check
    // would throw and the file would be force-downloaded as octet-stream.
    const content = Buffer.concat([
      Buffer.from('a'.repeat(4099)),
      Buffer.from('€ and then some more text to run past the window'),
    ]);
    const url = await put(content, 'long.txt', 'text/plain');
    const res = await agent.get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('inline');
  });

  it('404s an invalid key without touching the filesystem', async () => {
    const bad = ['../../etc/passwd', 'not-a-key', 'a1b2c3d4e5f6', 'ABCDEF012345.png'];
    for (const k of bad) {
      const res = await agent.get(`/uploads/local/${encodeURIComponent(k)}`);
      expect(res.status).toBe(404);
    }
  });

  it('404s a well-formed key with no file on disk', async () => {
    const res = await agent.get('/uploads/local/0123456789ab.png');
    expect(res.status).toBe(404);
  });
});
