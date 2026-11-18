// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { decodeHeic, stopHeicDecoder } from './heicDecode.js';
import { heicFixture, heicColourAt, HEIC_WIDTH, HEIC_HEIGHT } from '../test-utils/heicFixture.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-heic-'));
});
afterAll(() => {
  stopHeicDecoder();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('decodeHeic', () => {
  // The premise of the whole module, pinned: if a sharp upgrade ever ships an HEVC
  // decoder, this fails and says the detour can go.
  it('decodes a file the bundled sharp can read the header of and nothing more', async () => {
    const heic = heicFixture();
    const meta = await sharp(heic).metadata();
    expect(meta.format).toBe('heif');
    expect(meta.compression).toBe('hevc');
    await expect(sharp(heic).raw().toBuffer()).rejects.toThrow(/HEVC/);
  });

  it('returns the picture as upright RGBA', async () => {
    const image = await decodeHeic(heicFixture());

    expect(image.width).toBe(HEIC_WIDTH);
    expect(image.height).toBe(HEIC_HEIGHT);
    expect(image.pixels.length).toBe(HEIC_WIDTH * HEIC_HEIGHT * 4);
    const colour = (x: number, y: number) => heicColourAt(image.pixels, image.width, 4, x, y);
    // Top band, left half, right half — wrong if flipped, rotated, or BGR.
    expect(colour(48, 2)).toBe('green');
    expect(colour(10, 40)).toBe('red');
    expect(colour(85, 40)).toBe('blue');
    expect(image.pixels[(40 * image.width + 10) * 4 + 3]).toBe(255); // opaque
  });

  it('reads the image from a path, which is how an upload arrives', async () => {
    const file = path.join(dir, 'photo.heic');
    fs.writeFileSync(file, heicFixture());
    const image = await decodeHeic(file);
    expect([image.width, image.height]).toEqual([HEIC_WIDTH, HEIC_HEIGHT]);
  });

  it('rejects a file that is not one, with the decoder’s reason', async () => {
    await expect(decodeHeic(Buffer.from('not a heic, whatever it is called'))).rejects.toThrow(
      /Invalid input|parse/i,
    );
  });

  it('rejects a HEIC cut off inside its picture', async () => {
    const heic = heicFixture();
    await expect(decodeHeic(heic.subarray(0, 520))).rejects.toThrow(/end of file/i);
  });

  // One at a time, in the order asked — and a failure in the line does not strand
  // whoever is behind it.
  it('answers every caller when several ask at once', async () => {
    const results = await Promise.allSettled([
      decodeHeic(heicFixture()),
      decodeHeic(Buffer.from('garbage in the middle of the line')),
      decodeHeic(heicFixture()),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });

  it('starts a new process after the last one was let go', async () => {
    await decodeHeic(heicFixture());
    stopHeicDecoder();
    const image = await decodeHeic(heicFixture());
    expect(image.width).toBe(HEIC_WIDTH);
  });
});
