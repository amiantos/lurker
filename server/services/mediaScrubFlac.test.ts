// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubMediaFile, MediaScrubError } from './mediaScrub.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-flacscrub-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

const STREAMINFO = 0;
const PADDING = 1;
const APPLICATION = 2;
const SEEKTABLE = 3;
const VORBIS_COMMENT = 4;
const CUESHEET = 5;
const PICTURE = 6;

function block(type: number, body: Buffer, last = false): Buffer {
  const header = Buffer.alloc(4);
  header[0] = (last ? 0x80 : 0) | type;
  header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
}

/** Read the metadata blocks back: [type, length] each, and where the audio starts.
 *  Throws if the chain does not end in a block flagged last. */
function blocks(buf: Buffer, start = 0): { types: [number, number][]; audioAt: number } {
  expect(buf.toString('latin1', start, start + 4)).toBe('fLaC');
  const types: [number, number][] = [];
  let pos = start + 4;
  for (;;) {
    if (pos + 4 > buf.length) throw new Error('metadata chain runs off the file');
    const length = buf.readUIntBE(pos + 1, 3);
    types.push([buf[pos] & 0x7f, length]);
    const last = (buf[pos] & 0x80) !== 0;
    pos += 4 + length;
    if (last) return { types, audioAt: pos };
  }
}

const SECRETS = [
  'ARTIST=Someone Identifiable',
  'cover.jpg EXIF GPS +37.7749-122.4194',
  'ISRC US-S1Z-99-00001',
  'riff: recorded at 14 Elm Street',
];

const streamInfo = Buffer.alloc(34, 0x21);
const seekTable = Buffer.alloc(36, 0x43);
const frames = Buffer.concat([Buffer.from([0xff, 0xf8, 0xc9, 0x18]), Buffer.alloc(2000, 0x5c)]);

function flac(lastType = PADDING): Buffer {
  return Buffer.concat([
    Buffer.from('fLaC'),
    block(STREAMINFO, streamInfo),
    block(VORBIS_COMMENT, Buffer.from(SECRETS[0])),
    block(PICTURE, Buffer.from(SECRETS[1])),
    block(SEEKTABLE, seekTable),
    block(CUESHEET, Buffer.from(SECRETS[2])),
    block(APPLICATION, Buffer.from(SECRETS[3])),
    block(lastType, Buffer.alloc(64), true),
    frames,
  ]);
}

describe('scrubMediaFile — FLAC', () => {
  it('turns every tag, picture and cue sheet into padding, in place', async () => {
    const original = flac();
    const p = write('tagged.flac', original);
    for (const s of SECRETS) expect(original.includes(Buffer.from(s))).toBe(true);

    await scrubMediaFile(p, 'audio/flac');
    const after = fs.readFileSync(p);

    for (const s of SECRETS) expect(after.includes(Buffer.from(s))).toBe(false);
    expect(after.length).toBe(original.length);

    // Same chain, same lengths — only the types of the metadata-bearing blocks
    // changed, so the audio is exactly where the seek table says it is.
    const before = blocks(original);
    const now = blocks(after);
    expect(now.audioAt).toBe(before.audioAt);
    expect(now.types.map(([, length]) => length)).toEqual(before.types.map(([, l]) => l));
    expect(now.types.map(([type]) => type)).toEqual([
      STREAMINFO,
      PADDING,
      PADDING,
      SEEKTABLE,
      PADDING,
      PADDING,
      PADDING,
    ]);
    expect(after.includes(streamInfo)).toBe(true);
    expect(after.includes(seekTable)).toBe(true);
    expect(after.subarray(now.audioAt).equals(frames)).toBe(true);
  });

  // The "last block" flag lives in the same byte as the type. Retyping the final
  // block without carrying the flag over would make a decoder read the first audio
  // frame as a metadata header.
  it('keeps the last-block flag when the last block is the one it retypes', async () => {
    const original = flac(VORBIS_COMMENT);
    const p = write('last.flac', original);
    await scrubMediaFile(p, 'audio/flac');
    const after = fs.readFileSync(p);

    const now = blocks(after); // throws if the chain no longer terminates
    expect(now.types.at(-1)![0]).toBe(PADDING);
    expect(after.subarray(now.audioAt).equals(frames)).toBe(true);
  });

  // Some taggers put an ID3v2 tag in front of the stream and an ID3v1 after it —
  // neither belongs in a FLAC, both get written, and file-type looks straight past
  // the first one to call the file audio/flac.
  it('blanks an ID3 tag wrapped around the stream and still finds the blocks', async () => {
    const id3Body = Buffer.alloc(100);
    Buffer.from('TPE1 Secret Artist Name').copy(id3Body);
    const id3v2 = Buffer.concat([
      Buffer.from('ID3'),
      Buffer.from([4, 0, 0, 0, 0, 0, 100]),
      id3Body,
    ]);
    const id3v1 = Buffer.alloc(128);
    Buffer.from('TAGPrivate Title').copy(id3v1);
    const original = Buffer.concat([id3v2, flac(), id3v1]);
    const p = write('id3.flac', original);

    await scrubMediaFile(p, 'audio/flac');
    const after = fs.readFileSync(p);

    expect(after.includes(Buffer.from('Secret Artist Name'))).toBe(false);
    expect(after.includes(Buffer.from('Private Title'))).toBe(false);
    for (const s of SECRETS) expect(after.includes(Buffer.from(s))).toBe(false);
    expect(after.length).toBe(original.length);
    expect(blocks(after, id3v2.length).types.length).toBe(7);
  });

  it('refuses a block that claims to run past the end of the file', async () => {
    const bad = Buffer.concat([
      Buffer.from('fLaC'),
      block(STREAMINFO, streamInfo),
      Buffer.from([VORBIS_COMMENT, 0xff, 0xff, 0xff]),
      Buffer.from(SECRETS[0]),
    ]);
    await expect(scrubMediaFile(write('bad.flac', bad), 'audio/flac')).rejects.toBeInstanceOf(
      MediaScrubError,
    );
  });

  it('refuses a file with no FLAC stream in it', async () => {
    const p = write('not.flac', Buffer.from('nothing like a flac stream in here'));
    await expect(scrubMediaFile(p, 'audio/flac')).rejects.toBeInstanceOf(MediaScrubError);
  });
});
