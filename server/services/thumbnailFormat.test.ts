// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { thumbnail } from './imagePipeline.js';
import { thumbnailFormat } from './thumbnailFormat.js';

// Fixtures come from thumbnail() rather than hand-rolled headers: the sniff exists
// to read the bytes the pipeline ACTUALLY writes, so testing it against a
// hand-made RIFF header would only prove the header matches itself.
async function square(): Promise<Buffer> {
  return sharp({
    create: { width: 400, height: 200, channels: 3, background: { r: 255, g: 128, b: 64 } },
  })
    .png()
    .toBuffer();
}

describe('thumbnailFormat', () => {
  it('recognizes a WebP thumbnail (the default since #560)', async () => {
    expect(thumbnailFormat(await thumbnail(await square()))).toEqual({
      mime: 'image/webp',
      ext: 'webp',
    });
  });

  // The rows that make the sniff necessary: every thumbnail stored before #560 is
  // a JPEG, and they outlive the setting change.
  it('still reports a legacy JPEG thumbnail as image/jpeg', async () => {
    const legacy = await thumbnail(await square(), { format: 'jpeg' });
    expect(thumbnailFormat(legacy)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  });

  it("doesn't read past the end of a short or empty buffer", () => {
    // 'RIFF' alone is a prefix of the WebP magic but not the whole of it — the
    // length guard is what stops a truncated BLOB from reading as WebP.
    expect(thumbnailFormat(Buffer.from('RIFF')).mime).toBe('image/jpeg');
    expect(thumbnailFormat(Buffer.alloc(0)).mime).toBe('image/jpeg');
  });

  // RIFF is a container family, not WebP specifically (a .wav is RIFF too), so the
  // second half of the magic is load-bearing.
  it('does not mistake another RIFF container for WebP', () => {
    const wavish = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'latin1'),
    ]);
    expect(thumbnailFormat(wavish).mime).toBe('image/jpeg');
  });
});
