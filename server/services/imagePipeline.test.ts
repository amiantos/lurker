// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { optimize, thumbnail } from './imagePipeline.js';

// All fixtures are synthesised on the fly so the test stays self-contained
// and doesn't need committed binary blobs.

async function staticPng(width: number, height: number, color = { r: 255, g: 128, b: 64 }): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color },
  }).png().toBuffer();
}

// A hand-crafted 2-frame 1×1 GIF89a (white→black). Inlined as base64 because
// synthesising multi-page output via sharp is fiddly (its encoders don't honour
// pageHeight on raw-create input) and committing a binary fixture would be
// noisier than 85 bytes of text. The same passthrough branch handles animated
// WebP and APNG — we don't need separate fixtures to exercise it.
const TWO_FRAME_GIF_B64 =
  'R0lGODlhAQABAIAAAP///wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAA' +
  'AQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICRAEAOw==';
function animatedGif(): Buffer {
  return Buffer.from(TWO_FRAME_GIF_B64, 'base64');
}

describe('imagePipeline.optimize', () => {
  it('resizes and re-encodes a static PNG to JPEG with the longest edge clamped', async () => {
    const buf = await staticPng(4000, 2000);
    const out = await optimize(buf, { maxDim: 1024, quality: 80 });
    expect(out.mime).toBe('image/jpeg');
    expect(out.ext).toBe('jpg');
    expect(out.animated).toBe(false);
    expect(Math.max(out.width ?? 0, out.height ?? 0)).toBeLessThanOrEqual(1024);
    expect(out.byteSize).toBe(out.buffer.length);
    // Re-encoded JPEG is smaller than the original raw PNG
    expect(out.byteSize).toBeLessThan(buf.length);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it("doesn't upscale smaller-than-maxDim images", async () => {
    const buf = await staticPng(200, 200);
    const out = await optimize(buf, { maxDim: 1024, quality: 80 });
    expect(out.width).toBe(200);
    expect(out.height).toBe(200);
  });

  it('passes animated GIFs through verbatim with animated=true', async () => {
    const buf = animatedGif();
    const meta = await sharp(buf).metadata();
    expect((meta.pages != null ? meta.pages : 1) > 1).toBe(true);

    const out = await optimize(buf, { maxDim: 1024, quality: 80 });
    expect(out.animated).toBe(true);
    expect(out.mime).toBe('image/gif');
    expect(out.ext).toBe('gif');
    expect(out.buffer.length).toBe(buf.length);
    expect(Buffer.compare(out.buffer, buf)).toBe(0);
  });

  it('rejects unsupported formats with code UNSUPPORTED_FORMAT', async () => {
    const garbage = Buffer.from('this is definitely not an image');
    await expect(optimize(garbage, { maxDim: 1024, quality: 80 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });
});

describe('imagePipeline.thumbnail', () => {
  it('returns a 128x128 JPEG for static input', async () => {
    const buf = await staticPng(400, 200);
    const thumb = await thumbnail(buf);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(128);
    expect(meta.height).toBe(128);
  });

  it('returns a 128x128 JPEG for animated input (first frame)', async () => {
    const buf = animatedGif();
    const thumb = await thumbnail(buf);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(128);
    expect(meta.height).toBe(128);
  });
});
