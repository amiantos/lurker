// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { classifyUpload, UnsupportedTypeError } from './contentClass.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-classify-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

/** A minimal ISO-BMFF file: an ftyp box with the given brand, plus a moov. This is
 *  exactly what file-type keys off, so it's a faithful fixture. */
function bmff(brand: string, compat: string[] = ['isom', 'mp42']): Buffer {
  const brands = [brand, ...compat].map((b) => Buffer.from(b.padEnd(4, ' ')));
  const payload = Buffer.concat([Buffer.from(brand.padEnd(4, ' ')), Buffer.alloc(4), ...brands]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + payload.length);
  const moovBody = Buffer.alloc(16);
  const moovSize = Buffer.alloc(4);
  moovSize.writeUInt32BE(8 + moovBody.length);
  return Buffer.concat([
    size,
    Buffer.from('ftyp'),
    payload,
    moovSize,
    Buffer.from('moov'),
    moovBody,
  ]);
}

const mp3Frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]);

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** PNG + an acTL chunk = APNG, which file-type reports as `image/apng`. */
async function apngBytes(): Promise<Buffer> {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } })
    .png()
    .toBuffer();
  const idatAt = png.indexOf(Buffer.from('IDAT')) - 4;
  const data = Buffer.alloc(8);
  data.writeUInt32BE(2, 0);
  const body = Buffer.concat([Buffer.from('acTL'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([png.subarray(0, idatAt), len, body, crc, png.subarray(idatAt)]);
}

describe('classifyUpload — images', () => {
  it('classifies the formats the pipeline can optimize', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#0f0' } })
      .png()
      .toBuffer();
    const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#0f0' } })
      .jpeg()
      .toBuffer();

    for (const [name, bytes] of [
      ['a.png', png],
      ['a.jpg', jpg],
    ] as const) {
      const c = await classifyUpload(write(name, bytes), 'image/png');
      expect(c.contentClass).toBe('image');
    }
  });

  // ⚠ THE trap. file-type reports APNG as `image/apng`, which is NOT a key in
  // imagePipeline's FORMAT_INFO — so a naive FORMAT_INFO-derived alias set drops
  // APNG out of the image class entirely, into passthrough, silently un-doing
  // #516's frame-preserving metadata scrub for exactly the animated format it was
  // written for.
  it('routes APNG to the image pipeline (image/apng is not a sharp format name)', async () => {
    const c = await classifyUpload(write('anim.png', await apngBytes()), 'image/png');
    expect(c.contentClass).toBe('image');
  });

  // Same shape of trap: an iPhone photo sniffs as image/heic; sharp calls it heif.
  it('routes HEIC to the image pipeline (image/heic is not a sharp format name)', async () => {
    const c = await classifyUpload(write('photo.heic', bmff('heic', ['mif1'])), 'image/heic');
    expect(c.contentClass).toBe('image');
  });

  it('detects SVG, which has no magic bytes at all', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const c = await classifyUpload(write('bare.svg', svg), 'image/svg+xml');
    expect(c.contentClass).toBe('image');
    expect(c.mime).toBe('image/svg+xml');
  });

  // ⚠ A REAL SVG — what Illustrator and Inkscape write — opens with an XML
  // declaration, and file-type reports THAT as `application/xml`. Treating every
  // recognized-but-unaccepted type as a refusal would have 415'd every real SVG
  // file, breaking an upload that works today.
  it('detects an SVG with an XML prolog (file-type calls it application/xml)', async () => {
    const svg = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!-- Generator: Adobe Illustrator -->\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>',
    );
    const c = await classifyUpload(write('real.svg', svg), 'image/svg+xml');
    expect(c.contentClass).toBe('image');
    expect(c.mime).toBe('image/svg+xml');
  });

  // …and the same bytes claimed as text/plain (the long-message flow) stay text.
  it('an XML document that is not an SVG is text', async () => {
    const xml = Buffer.from('<?xml version="1.0"?>\n<note><to>you</to></note>');
    const c = await classifyUpload(write('doc.xml', xml), 'application/xml');
    expect(c.contentClass).toBe('text');
    expect(c.ext).toBe('txt');
  });
});

describe('classifyUpload — media', () => {
  it('accepts exactly the containers we can scrub', async () => {
    const cases: [string, Buffer, string, string][] = [
      ['v.mp4', bmff('isom'), 'video/mp4', 'mp4'],
      ['v.mov', bmff('qt  ', []), 'video/quicktime', 'mov'],
      ['v.m4v', bmff('M4V '), 'video/x-m4v', 'm4v'],
      ['a.m4a', bmff('M4A '), 'audio/x-m4a', 'm4a'],
      ['a.mp3', mp3Frame, 'audio/mpeg', 'mp3'],
    ];
    for (const [name, bytes, mime, ext] of cases) {
      const c = await classifyUpload(write(name, bytes), 'application/octet-stream');
      expect({ name, ...c }).toEqual({ name, contentClass: 'media', mime, ext });
    }
  });

  it('rejects media we have no scrubber for, rather than leaking its metadata', async () => {
    // WebM: harmless in practice (a browser recorder writes a muxer name and a
    // date, not a location), but "everything we accept, we clean" is the rule, and
    // we have no EBML scrubber yet. A real EBML header, not a stub — file-type needs
    // to read as far as the DocType to call it webm.
    const webm = Buffer.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2,
      0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87,
      0x81, 0x02, 0x42, 0x85, 0x81, 0x02, 0x18, 0x53, 0x80, 0x67, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
    ]);
    await expect(classifyUpload(write('v.webm', webm), 'video/webm')).rejects.toBeInstanceOf(
      UnsupportedTypeError,
    );
  });
});

describe('classifyUpload — the client cannot talk us out of the truth', () => {
  // The whole reason this module exists. If a claimed MIME could pick the class, it
  // would be a route around imagePipeline.optimize() — i.e. around the EXIF scrub.
  it('sends an image through the image pipeline however it is announced', async () => {
    const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00f' } })
      .jpeg()
      .toBuffer();
    const p = write('liar.mp4', jpg);
    for (const claim of ['video/mp4', 'application/octet-stream', 'text/plain', '']) {
      const c = await classifyUpload(p, claim);
      expect(c.contentClass).toBe('image');
    }
  });

  it('will not let a claimed text/plain smuggle arbitrary bytes through as .txt', async () => {
    // Invalid UTF-8, no signature. The old route trusted the claim and passed it
    // through with a .txt extension; now the whole file has to actually be text.
    const junk = Buffer.from([0xc3, 0x28, 0xa0, 0xa1, 0xff, 0xfe, 0x00, 0x01]);
    await expect(classifyUpload(write('junk.txt', junk), 'text/plain')).rejects.toBeInstanceOf(
      UnsupportedTypeError,
    );
  });

  // The long-message → .txt flow ALWAYS claims text/plain. Someone pasting raw SVG
  // markup into the composer must not have it reclassified as an image (which on
  // hosted, where SVG is refused, would turn a working upload into a 415).
  it('keeps SVG markup pasted into the composer as text', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const c = await classifyUpload(write('pasted.txt', svg), 'text/plain');
    expect(c.contentClass).toBe('text');
    expect(c.ext).toBe('txt');
  });
});

describe('classifyUpload — text and refusals', () => {
  it('classifies plain UTF-8 as text', async () => {
    const c = await classifyUpload(write('n.txt', Buffer.from('hello — ünïcodé\n')), 'text/plain');
    expect(c).toEqual({ contentClass: 'text', mime: 'text/plain', ext: 'txt' });
  });

  it('handles a multibyte char straddling the streaming read boundary', async () => {
    // 64 KB is the chunk size; land a 3-byte '€' across the seam. A naive
    // per-chunk UTF-8 check would call this binary and refuse a perfectly good file.
    const head = Buffer.from('a'.repeat(64 * 1024 - 1));
    const c = await classifyUpload(
      write('big.txt', Buffer.concat([head, Buffer.from('€ trailing text')])),
      'text/plain',
    );
    expect(c.contentClass).toBe('text');
  });

  it('refuses recognized types outside the accepted set, naming what is allowed', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
    for (const [name, bytes] of [
      ['d.pdf', pdf],
      ['a.zip', zip],
    ] as const) {
      await expect(classifyUpload(write(name, bytes), 'application/pdf')).rejects.toThrow(
        /not accepted/,
      );
    }
  });

  it('refuses an empty file', async () => {
    await expect(
      classifyUpload(write('empty.txt', Buffer.alloc(0)), 'text/plain'),
    ).rejects.toBeInstanceOf(UnsupportedTypeError);
  });
});
