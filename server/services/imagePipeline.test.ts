// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { avatar, optimize, prepareImage, thumbnail } from './imagePipeline.js';
import { stopHeicDecoder } from './heicDecode.js';
import { heicFixture, heicColourAt, HEIC_WIDTH, HEIC_HEIGHT } from '../test-utils/heicFixture.js';

// All fixtures are synthesised on the fly so the test stays self-contained
// and doesn't need committed binary blobs.

async function staticPng(
  width: number,
  height: number,
  color = { r: 255, g: 128, b: 64 },
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

// A PNG with a real alpha channel: opaque red square centred on a fully
// transparent field — a logo/sticker/screenshot-with-rounded-corners in
// miniature. The transparent border is what JPEG destroys.
async function transparentPng(size = 64): Promise<Buffer> {
  const square = await sharp({
    create: {
      width: size / 2,
      height: size / 2,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: square, left: size / 4, top: size / 4 }])
    .png()
    .toBuffer();
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
  it('resizes and re-encodes a static PNG to WebP with the longest edge clamped', async () => {
    const buf = await staticPng(4000, 2000);
    const out = await optimize(buf, { maxDim: 1024, quality: 80 });
    expect(out.mime).toBe('image/webp');
    expect(out.ext).toBe('webp');
    expect(out.animated).toBe(false);
    expect(Math.max(out.width ?? 0, out.height ?? 0)).toBeLessThanOrEqual(1024);
    expect(out.byteSize).toBe(out.buffer.length);
    // Re-encoded is smaller than the original raw PNG
    expect(out.byteSize).toBeLessThan(buf.length);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('webp');
  });

  // The bug #560 exists to fix. JPEG has no alpha channel, so the old
  // unconditional .jpeg() composited every transparent pixel onto BLACK (verified
  // against sharp — not white, black) and shipped that as the file the channel saw.
  it('preserves the alpha channel of a transparent PNG', async () => {
    const buf = await transparentPng(64);
    const out = await optimize(buf, { maxDim: 1024, quality: 80 });

    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.hasAlpha).toBe(true);

    // The corner was transparent going in; it must still be transparent, not black.
    const px = await sharp(out.buffer).ensureAlpha().raw().toBuffer();
    expect(px[3]).toBe(0);
  });

  // The reason optimize() re-encodes static images at all (#516): the re-encode is
  // what drops EXIF, and a phone photo's EXIF carries GPS. That guarantee is a
  // property of the ENCODER, and #560 swapped it — so assert it for both, or the
  // next format change (AVIF) can silently reopen the leak with a green suite.
  it.each(['webp', 'jpeg'] as const)('strips EXIF/GPS when re-encoding to %s', async (format) => {
    const withExif = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .withExif({
        IFD0: { Make: 'SECRET-CAMERA', Model: 'SECRET-MODEL' },
        IFD3: { GPSLatitude: '40/1 44/1 5595/100', GPSLongitude: '73/1 59/1 5100/100' },
      })
      .jpeg()
      .toBuffer();
    // The fixture really does carry it, or the assertions below prove nothing.
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();

    const out = await optimize(withExif, { maxDim: 2048, quality: 85, format });
    expect((await sharp(out.buffer).metadata()).exif).toBeFalsy();
    const raw = out.buffer.toString('latin1');
    expect(raw).not.toContain('SECRET-CAMERA');
    expect(raw).not.toContain('SECRET-MODEL');
  });

  it('flattens alpha when the user opts into the jpeg escape hatch', async () => {
    const buf = await transparentPng(64);
    const out = await optimize(buf, { maxDim: 1024, quality: 80, format: 'jpeg' });
    expect(out.mime).toBe('image/jpeg');
    expect(out.ext).toBe('jpg');
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    // Documenting the cost of the escape hatch, not endorsing it: JPEG cannot
    // carry alpha, so choosing it is choosing this.
    expect(meta.hasAlpha).toBe(false);
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

  it('scrubs a Comment Extension from an animated GIF while keeping frames', async () => {
    const base = animatedGif();
    const comment = Buffer.concat([
      Buffer.from([0x21, 0xfe, 0x0a]),
      Buffer.from('SECRET-GPS', 'latin1'),
      Buffer.from([0x00]),
    ]);
    // Splice the comment in just before the trailer (final 0x3B byte).
    const withComment = Buffer.concat([
      base.subarray(0, base.length - 1),
      comment,
      base.subarray(base.length - 1),
    ]);

    const out = await optimize(withComment, { maxDim: 1024, quality: 80 });
    expect(out.animated).toBe(true);
    expect(out.byteSize).toBe(out.buffer.length);
    expect(out.buffer.toString('latin1')).not.toContain('SECRET-GPS');
    // Still a valid, still-animated GIF.
    const meta = await sharp(out.buffer).metadata();
    expect(meta.format).toBe('gif');
    expect((meta.pages ?? 1) > 1).toBe(true);
  });

  it('scrubs <metadata> and comments from a passed-through SVG', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
        '<!-- SECRET-GPS 40.7,-74.0 --><metadata>SECRET-META</metadata>' +
        '<rect width="10" height="10"/></svg>',
      'utf8',
    );
    const out = await optimize(svg, { maxDim: 1024, quality: 80 });
    expect(out.mime).toBe('image/svg+xml');
    expect(out.byteSize).toBe(out.buffer.length);
    const text = out.buffer.toString('utf8');
    expect(text).not.toContain('SECRET-GPS');
    expect(text).not.toContain('SECRET-META');
    expect(text).toContain('<rect width="10" height="10"/>');
  });

  it('rejects unsupported formats with code UNSUPPORTED_FORMAT', async () => {
    const garbage = Buffer.from('this is definitely not an image');
    await expect(optimize(garbage, { maxDim: 1024, quality: 80 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  // A header that reads and pixels that do not: a photo cut off mid-transfer, or a
  // codec this libvips has no decoder for. metadata() is happy with both, so the
  // failure arrives from the encode — which used to be unguarded, and reached the
  // route as an error it had no status for (a 500).
  it('rejects an image whose header reads but whose pixels do not decode', async () => {
    const whole = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 3,
        background: '#888',
        noise: { type: 'gaussian', mean: 128 },
      },
    })
      .png()
      .toBuffer();
    const cut = whole.subarray(0, 200);
    expect((await sharp(cut).metadata()).format).toBe('png'); // the header really does read

    await expect(optimize(cut, { maxDim: 1024, quality: 80 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
    await expect(thumbnail(cut)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    await expect(avatar(cut, { quality: 80 })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  it('passes SVG through unchanged in standalone (rasterOnly off)', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    const out = await optimize(svg, { maxDim: 1024, quality: 80 });
    expect(out.mime).toBe('image/svg+xml');
    expect(out.ext).toBe('svg');
    expect(Buffer.compare(out.buffer, svg)).toBe(0);
  });

  it('rejects SVG with UNSUPPORTED_FORMAT when rasterOnly (node edition)', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    await expect(
      optimize(svg, { maxDim: 1024, quality: 80, rasterOnly: true }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });
});

describe('imagePipeline.thumbnail', () => {
  it('returns a 512x512 WebP for static input', async () => {
    const buf = await staticPng(400, 200);
    const thumb = await thumbnail(buf);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it('returns a 512x512 WebP for animated input (first frame)', async () => {
    const buf = animatedGif();
    const thumb = await thumbnail(buf);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it('keeps alpha, so a transparent image thumbnails without a black backing', async () => {
    const thumb = await thumbnail(await transparentPng(64));
    const meta = await sharp(thumb).metadata();
    expect(meta.hasAlpha).toBe(true);
    const px = await sharp(thumb).ensureAlpha().raw().toBuffer();
    expect(px[3]).toBe(0);
  });

  it('follows the jpeg escape hatch', async () => {
    const thumb = await thumbnail(await staticPng(400, 200), { format: 'jpeg' });
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(512);
  });
});

describe('imagePipeline.avatar', () => {
  // A 3-frame GIF big enough to crop, made from raw frames stacked by pageHeight.
  async function animatedGifSized(width: number, height: number, pages = 3): Promise<Buffer> {
    const raw = Buffer.alloc(width * height * pages * 4);
    for (let i = 0; i < raw.length; i += 4) {
      raw[i] = Math.floor(i / (width * height * 4)) * 100;
      raw[i + 3] = 255;
    }
    return sharp(raw, { raw: { width, height: height * pages, channels: 4, pageHeight: height } })
      .gif()
      .toBuffer();
  }

  it('crops a still to a 512 square, as WebP', async () => {
    const out = await avatar(await staticPng(1200, 800), { quality: 80 });
    const meta = await sharp(out.buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 512, 512]);
    expect([out.width, out.height, out.animated, out.mime]).toEqual([
      512,
      512,
      false,
      'image/webp',
    ]);
  });

  it('never enlarges: a small image becomes the square of its short side', async () => {
    const out = await avatar(await staticPng(300, 200), { quality: 80 });
    const meta = await sharp(out.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([200, 200]);
  });

  it('keeps an animated GIF animated, each frame cropped', async () => {
    const out = await avatar(await animatedGifSized(300, 200), { quality: 80 });
    const meta = await sharp(out.buffer, { animated: true }).metadata();
    expect([meta.format, meta.pages, meta.width, meta.pageHeight]).toEqual(['gif', 3, 200, 200]);
    expect([out.animated, out.mime]).toEqual([true, 'image/gif']);
  });

  it("cuts an animated one to the decoder's 256, not a still's 512", async () => {
    const out = await avatar(await animatedGifSized(400, 300), { quality: 80 });
    const meta = await sharp(out.buffer, { animated: true }).metadata();
    expect([meta.pages, meta.width, meta.pageHeight]).toEqual([3, 256, 256]);
    expect([out.width, out.height, out.animated]).toEqual([256, 256, true]);
  });

  it('rasterises an SVG to a full-size square', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10">' +
        '<rect width="20" height="10" fill="red"/></svg>',
    );
    const out = await avatar(svg, { quality: 80 });
    const meta = await sharp(out.buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 512, 512]);
  });

  it('follows the jpeg escape hatch', async () => {
    const out = await avatar(await staticPng(600, 600), { quality: 80, format: 'jpeg' });
    expect((await sharp(out.buffer).metadata()).format).toBe('jpeg');
    expect(out.ext).toBe('jpg');
  });
});

// thumbnailFormat() has its own suite (thumbnailFormat.test.ts). Its fixtures come
// from thumbnail() here, so the two stay honest about each other: the sniff is
// tested against bytes this pipeline really produces, not a hand-rolled header.

// An iPhone photo. The bundled sharp reads its header and cannot decode it, so
// prepareImage hands it to the HEVC decoder (services/heicDecode.ts) and everything
// after that is the ordinary pipeline, working from pixels.
describe('HEIC', () => {
  afterAll(() => stopHeicDecoder());

  const pixelsOf = async (image: Buffer) =>
    sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });

  it('leaves every other image exactly as it came', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0f0' } })
      .png()
      .toBuffer();
    expect(await prepareImage(png)).toBe(png);
    // AVIF is the same container as HEIC with a codec sharp DOES decode. It must
    // not take the detour: sharp keeps its colour profile, the detour would not.
    const avif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0f0' } })
      .avif()
      .toBuffer();
    expect(await prepareImage(avif)).toBe(avif);
  });

  it('optimizes a HEIC to the requested format, the right way up', async () => {
    const source = await prepareImage(heicFixture());
    const out = await optimize(source, { maxDim: 2048, quality: 90 });

    expect(out.mime).toBe('image/webp');
    expect(out.ext).toBe('webp');
    expect([out.width, out.height]).toEqual([HEIC_WIDTH, HEIC_HEIGHT]);
    expect(out.animated).toBe(false);

    const { data, info } = await pixelsOf(out.buffer);
    const colour = (x: number, y: number) => heicColourAt(data, info.width, info.channels, x, y);
    expect(colour(48, 2)).toBe('green');
    expect(colour(10, 40)).toBe('red');
    expect(colour(85, 40)).toBe('blue');
  });

  it('carries none of the original’s metadata into the output', async () => {
    // The fixture has an Exif item; a camera’s would hold the GPS fix. Raw pixels
    // have nowhere to keep one.
    const out = await optimize(await prepareImage(heicFixture()), { maxDim: 2048, quality: 90 });
    const meta = await sharp(out.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(out.buffer.includes(Buffer.from('Exif'))).toBe(false);
  });

  it('honours maxDim and the jpeg format', async () => {
    const out = await optimize(await prepareImage(heicFixture()), {
      maxDim: 48,
      quality: 80,
      format: 'jpeg',
    });
    expect(out.mime).toBe('image/jpeg');
    expect([out.width, out.height]).toEqual([48, 32]);
  });

  it('thumbnails and avatars from the same decoded pixels', async () => {
    const source = await prepareImage(heicFixture());
    const thumb = await sharp(await thumbnail(source)).metadata();
    expect([thumb.width, thumb.height]).toEqual([512, 512]);
    const face = await avatar(source, { quality: 80 });
    expect([face.width, face.height]).toEqual([HEIC_HEIGHT, HEIC_HEIGHT]); // never enlarged
  });

  it('reads a HEIC from a path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-heic-pipeline-'));
    try {
      const file = path.join(dir, 'IMG_0001.HEIC');
      fs.writeFileSync(file, heicFixture());
      const out = await optimize(await prepareImage(file), { maxDim: 2048, quality: 90 });
      expect([out.width, out.height]).toEqual([HEIC_WIDTH, HEIC_HEIGHT]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a HEIC neither decoder can read, as an unsupported format', async () => {
    await expect(prepareImage(heicFixture().subarray(0, 520))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });
});
