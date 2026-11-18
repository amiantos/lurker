// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The HEIC process: a child of the server that decodes one HEVC-coded HEIF image
// at a time to raw pixels (services/heicDecode.ts starts it and says why it is a
// process). Like searchProcess.ts, keep this file free of the app's modules — it
// is started on the first HEIC and again after every idle exit, and all it needs is
// the decoder.

import fs from 'node:fs';
import { createRequire } from 'node:module';

interface Request {
  id: number;
  /** The image: a file to read, or the bytes themselves. */
  path?: string;
  bytes?: Uint8Array;
  /** Refuse anything larger, before allocating for it. */
  maxPixels: number;
}

interface HeifImage {
  get_width(): number;
  get_height(): number;
  is_primary(): boolean;
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    done: (result: unknown) => void,
  ): void;
  free(): void;
}

if (!process.send) {
  console.error('[heic] heicProcess is started by the server');
  process.exit(2);
}
// A reply the server is no longer there to read ends the process, quietly — see
// searchProcess.ts.
const send = (reply: unknown) =>
  process.send!(reply, (err: Error | null) => {
    if (err) process.exit(0);
  });

// libheif compiled to WebAssembly, with libde265 — the HEVC decoder sharp's
// prebuilt libvips leaves out. CommonJS, with the .wasm inlined, so it loads
// synchronously and needs no file beside it.
const libheif = createRequire(import.meta.url)('libheif-js/wasm-bundle') as {
  HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] };
};

async function decode(bytes: Uint8Array, maxPixels: number) {
  // The wrapper reports a file it cannot parse with console.log and an empty
  // list. That line is the only place the reason exists (a security limit, a
  // truncated box), so it is caught rather than left to land in the server's log.
  let reason = '';
  const log = console.log;
  console.log = (...args: unknown[]) => {
    reason = args.map(String).join(' ');
  };
  let images: HeifImage[];
  try {
    images = new libheif.HeifDecoder().decode(bytes);
  } finally {
    console.log = log;
  }
  if (!images.length) throw new Error(reason || 'no image in this HEIF file');

  // The primary image is the photo. The others an iPhone writes beside it — depth
  // map, HDR gain map — are not pictures to show.
  const image = images.find((i) => i.is_primary()) ?? images[0];
  try {
    // Already upright: libheif applies the container's rotation and mirroring as
    // it decodes, and these are the dimensions after it has.
    const width = image.get_width();
    const height = image.get_height();
    if (!(width > 0 && height > 0) || width * height > maxPixels) {
      throw new Error(`image is ${width}x${height}, larger than this server decodes`);
    }
    const data = new Uint8ClampedArray(width * height * 4);
    // The wrapper defers the decode to a timer and answers null when it fails —
    // so the images must not be freed until it has called back.
    const result = await new Promise((resolve) => image.display({ data, width, height }, resolve));
    if (!result) throw new Error('the HEVC decoder could not decode this image');
    return { width, height, pixels: Buffer.from(data.buffer, data.byteOffset, data.byteLength) };
  } finally {
    for (const i of images) i.free();
  }
}

process.on('message', async (request: Request) => {
  try {
    const bytes = request.path ? fs.readFileSync(request.path) : request.bytes!;
    send({ id: request.id, ...(await decode(bytes, request.maxPixels)) });
  } catch (err) {
    send({ id: request.id, error: err instanceof Error ? err.message : String(err) });
  }
});
// The server is gone: nothing is left to answer.
process.on('disconnect', () => process.exit(0));
