// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { classifyUpload, storedContentType, UnsupportedTypeError } from './contentClass.js';

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

/** An EBML header with the given DocType and the start of a Segment — as far as
 *  file-type reads to tell WebM from Matroska. */
function ebml(docType: string): Buffer {
  const doc = Buffer.from(docType);
  const fields = Buffer.concat([
    Buffer.from([0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04]),
    Buffer.from([0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x80 | doc.length]),
    doc,
    Buffer.from([0x42, 0x87, 0x81, 0x02, 0x42, 0x85, 0x81, 0x02]),
  ]);
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | fields.length]),
    fields,
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
  ]);
}

/** The first page of an Ogg stream, whose first packet opens with `codec`. That
 *  opening is all file-type looks at. */
function oggPage(codec: string): Buffer {
  const packet = Buffer.concat([Buffer.from(codec, 'latin1'), Buffer.alloc(40, 1)]);
  const header = Buffer.alloc(28);
  header.write('OggS', 0, 'latin1');
  header[5] = 0x02; // beginning of stream
  header[26] = 1;
  header[27] = packet.length;
  return Buffer.concat([header, packet]);
}

const flacStream = Buffer.concat([
  Buffer.from('fLaC'),
  Buffer.from([0x80, 0, 0, 34]),
  Buffer.alloc(34, 2),
]);

const wavFile = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([36, 0, 0, 0]),
  Buffer.from('WAVEfmt '),
  Buffer.alloc(24, 1),
]);

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
      // An ISO-BMFF stamped with one of the four audio brands (M4B/F4A/F4B) sniffs as
      // audio/mp4, not audio/x-m4a. Same box structure → served as .m4a.
      ['a.m4b', bmff('M4B ', []), 'audio/mp4', 'm4a'],
      ['a.f4a', bmff('F4A ', []), 'audio/mp4', 'm4a'],
      // Samsung's stock voice recorder writes a 3GPP container and names it `.m4a`.
      // Still ISO-BMFF → scrubbable, and served under its honest extension.
      ['rec.m4a', bmff('3gp4', ['isom', '3gp4']), 'video/3gpp', '3gp'],
      ['v.3g2', bmff('3g2a', []), 'video/3gpp2', '3g2'],
      ['a.mp3', mp3Frame, 'audio/mpeg', 'mp3'],
      // #553. A screen recording, an OBS capture, and the three audio containers.
      ['v.webm', ebml('webm'), 'video/webm', 'webm'],
      ['v.mkv', ebml('matroska'), 'video/matroska', 'mkv'],
      ['a.ogg', oggPage('\x01vorbis'), 'audio/ogg', 'ogg'],
      ['v.ogv', oggPage('\x80theora'), 'video/ogg', 'ogv'],
      ['a.flac', flacStream, 'audio/flac', 'flac'],
      ['a.wav', wavFile, 'audio/wav', 'wav'],
    ];
    for (const [name, bytes, mime, ext] of cases) {
      const c = await classifyUpload(write(name, bytes), 'application/octet-stream');
      expect({ name, ...c }).toEqual({ name, contentClass: 'media', mime, ext });
    }
  });

  it('does NOT treat audio/mp4 as "the audio-only MIME"', async () => {
    // The trap this pins: file-type keys ISO-BMFF off the major `ftyp` brand alone and
    // has no idea whether there's a video track. An audio-only recording with an
    // ordinary `mp42`/`isom` brand — which is most of them — falls to the switch's
    // DEFAULT and sniffs as video/mp4. Only M4B/F4A/F4B ever produce audio/mp4.
    //
    // A comment in contentClass.ts once claimed otherwise, and the claim is invisible
    // in production because both MIMEs are accepted and scrub identically. It would
    // only surface as a wrong `ext`, so it needs a test rather than prose.
    const c = await classifyUpload(write('audio-only.m4a', bmff('mp42', ['isom'])), 'audio/x-m4a');
    expect(c.mime).toBe('video/mp4');
    expect(c.ext).toBe('mp4');
  });

  // file-type hands Opus back with its codec parameter attached. That string is a
  // fine Content-Type and a poor identity: the scrubber dispatches on the mime, the
  // uploads browser files the row by it, and a driver may match it against a list of
  // bare types. The parameter is kept where it is useful, as the extension.
  it('records Opus under the bare audio/ogg, and keeps .opus as the extension', async () => {
    const c = await classifyUpload(write('memo.opus', oggPage('OpusHead')), 'audio/ogg');
    expect(c).toEqual({ contentClass: 'media', mime: 'audio/ogg', ext: 'opus' });
  });

  it('rejects media we have no scrubber for, rather than leaking its metadata', async () => {
    // AVI: a RIFF container like WAV, with `LIST`/`INFO` chunks like WAV — and an
    // index of absolute offsets the WAV scrubber knows nothing about. "Everything we
    // accept, we clean" is the rule, and nothing here cleans it.
    const avi = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([64, 0, 0, 0]),
      Buffer.from('AVI LIST'),
      Buffer.alloc(56, 1),
    ]);
    await expect(classifyUpload(write('v.avi', avi), 'video/avi')).rejects.toBeInstanceOf(
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

  // file-type 22.1 reads `CD001` at byte 32769 as an ISO image, with nothing else to
  // check. A long paste with those bytes there is still text, and binary bytes behind
  // the same signature still don't get in.
  it('decides an ISO 9660 signature by the UTF-8 check, not the sniff', async () => {
    const at = (fill: Buffer) =>
      Buffer.concat([fill.subarray(0, 32769), Buffer.from('CD001'), Buffer.from(' tail\n')]);
    const text = await classifyUpload(write('log.txt', at(Buffer.alloc(32769, 'a'))), 'text/plain');
    expect(text.contentClass).toBe('text');
    await expect(
      classifyUpload(write('disc.iso', at(Buffer.alloc(32769, 0xff))), 'text/plain'),
    ).rejects.toBeInstanceOf(UnsupportedTypeError);
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

  // #788. These bytes were ALWAYS accepted — signature-less UTF-8 is what the text
  // branch takes — so this is about the label, not the gate. A README came back as
  // `README.txt`, and a `.json` lost the one thing telling an editor how to read it.
  it('names the text dialects from the claimed mime', async () => {
    const cases: [string, string, string][] = [
      ['text/plain', 'text/plain', 'txt'],
      ['text/markdown', 'text/markdown', 'md'],
      ['application/json', 'application/json', 'json'],
    ];
    for (const [claim, mime, ext] of cases) {
      const c = await classifyUpload(write(`d-${ext}`, Buffer.from('# notes — ünïcodé\n')), claim);
      expect({ claim, ...c }).toEqual({ claim, contentClass: 'text', mime, ext });
    }
  });

  // ⚠ The portability gap the filename fallback exists for: macOS and Linux register
  // a mime for `.md`, Windows registers none — so the same file arrives claiming
  // `text/plain` or `application/octet-stream` and would flatten back to `.txt`. The
  // feature would simply not work there, silently.
  it('falls back to the filename extension when the platform sends no mime', async () => {
    const bytes = Buffer.from('# heading\n');
    for (const claim of ['text/plain', 'application/octet-stream', '']) {
      const c = await classifyUpload(write('notes.md', bytes), claim, 'notes.md');
      expect({ claim, ext: c.ext, mime: c.mime }).toEqual({
        claim,
        ext: 'md',
        mime: 'text/markdown',
      });
    }
    const j = await classifyUpload(write('d.json', Buffer.from('{"a":1}')), '', 'data.JSON');
    expect(j.ext).toBe('json');
  });

  // The rule the dialect map is a bounded exception to: the served extension can only
  // ever be one of the three, whatever the caller says it is. An `.html` that decodes
  // as UTF-8 is still text, and still lands as `.txt`.
  it('never lets an unlisted extension become the served one', async () => {
    for (const name of ['evil.html', 'evil.svg', 'x.tar.gz', 'no-extension', '.bashrc']) {
      const c = await classifyUpload(write('claim.txt', Buffer.from('plain words')), '', name);
      expect({ name, ext: c.ext, mime: c.mime }).toEqual({
        name,
        ext: 'txt',
        mime: 'text/plain',
      });
    }
  });

  // The claim, not the filename, decides whether the SVG probe runs — so a name can
  // never suppress it for bytes that really are SVG.
  it("keeps the SVG probe on the claim, out of the filename's reach", async () => {
    const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>');
    const hijack = await classifyUpload(write('a.svg', svg), 'image/svg+xml', 'notes.txt');
    expect(hijack).toEqual({ contentClass: 'image', mime: 'image/svg+xml', ext: 'svg' });

    // …and the exemption widened with the map: a file the user explicitly named `.md`
    // stays markdown rather than being called an image. Served as text/markdown it is
    // every bit as inert, and "your README is an SVG" is the more surprising answer.
    const md = await classifyUpload(write('b.svg', svg), 'text/markdown', 'notes.md');
    expect(md).toEqual({ contentClass: 'text', mime: 'text/markdown', ext: 'md' });
  });

  // The bytes still rule the CLASS. A dialect claim is not a way past the UTF-8 gate.
  it('will not let a dialect claim smuggle binary through', async () => {
    const junk = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x99]);
    for (const claim of ['text/markdown', 'application/json']) {
      await expect(classifyUpload(write('junk.md', junk), claim, 'junk.md')).rejects.toBeInstanceOf(
        UnsupportedTypeError,
      );
    }
  });

  // #788's actual bug: bytes fine, label incomplete. A browser handed bare
  // `text/plain` decodes it with a legacy fallback encoding (Latin-1 on Safari), so
  // every `—` in a UTF-8 paste renders as `â€"`.
  it('states the charset on stored text, but not on JSON', () => {
    expect(storedContentType('text/plain')).toBe('text/plain; charset=utf-8');
    expect(storedContentType('text/markdown')).toBe('text/markdown; charset=utf-8');
    // RFC 8259 defines no charset parameter for application/json and mandates UTF-8.
    expect(storedContentType('application/json')).toBe('application/json');
    // Untouched for everything else — it is a header helper, not a mime rewriter.
    expect(storedContentType('image/png')).toBe('image/png');
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
