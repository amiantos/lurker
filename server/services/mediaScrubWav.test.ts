// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubMediaFile, MediaScrubError } from './mediaScrub.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-wavscrub-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

/** A RIFF chunk, padded to an even length as the format requires. */
function chunk(id: string, body: Buffer, declared = body.length): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'latin1');
  header.writeUInt32LE(declared >>> 0, 4);
  return Buffer.concat([header, body, Buffer.alloc(body.length & 1)]);
}

function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Walk the chunks back out: [id, declared length, offset]. Throws if one does not
 *  fit, which is what a scrub that moved anything would cause. */
function chunksOf(buf: Buffer): [string, number, number][] {
  expect(buf.toString('latin1', 0, 4)).toBe('RIFF');
  expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
  expect(buf.toString('latin1', 8, 12)).toBe('WAVE');
  const out: [string, number, number][] = [];
  let pos = 12;
  while (pos < buf.length) {
    const length = buf.readUInt32LE(pos + 4);
    if (pos + 8 + length > buf.length) throw new Error('chunk overruns the file');
    out.push([buf.toString('latin1', pos, pos + 4), length, pos]);
    pos += 8 + length + (length & 1);
  }
  return out;
}

// 16-bit mono PCM at 8 kHz.
const fmt = Buffer.from([1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0]);
const samples = Buffer.alloc(4000, 0x3d);

const SECRETS = [
  'IART Someone Identifiable', // odd length on purpose: exercises the pad byte
  'bext: ZOOM H6 serial 00412 2026-03-14 09:12:44',
  '<BWFXML><PROJECT>Interview at 14 Elm Street</PROJECT>',
  'ID3 TPE1 Secret Artist Name',
  'smpl: something only this recorder writes',
];

function wav(): Buffer {
  return riff([
    chunk('LIST', Buffer.concat([Buffer.from('INFO'), Buffer.from(SECRETS[0])])),
    chunk('fmt ', fmt),
    chunk('bext', Buffer.from(SECRETS[1])),
    chunk('fact', Buffer.from([0xd0, 0x07, 0, 0])),
    chunk('data', samples),
    chunk('iXML', Buffer.from(SECRETS[2])),
    chunk('id3 ', Buffer.from(SECRETS[3])),
    chunk('zzzz', Buffer.from(SECRETS[4])), // a chunk nobody has heard of
  ]);
}

describe('scrubMediaFile — WAV', () => {
  it('blanks every chunk but the format and the samples, in place', async () => {
    const original = wav();
    const p = write('tagged.wav', original);
    for (const s of SECRETS) expect(original.includes(Buffer.from(s))).toBe(true);

    await scrubMediaFile(p, 'audio/wav');
    const after = fs.readFileSync(p);

    for (const s of SECRETS) expect(after.includes(Buffer.from(s))).toBe(false);
    expect(after.length).toBe(original.length);

    // chunksOf also checks the RIFF length still matches the file. Every chunk is
    // where it was and as long as it was; the ones that held metadata are padding.
    const before = chunksOf(original);
    const now = chunksOf(after);
    expect(now.map(([, length, at]) => [length, at])).toEqual(
      before.map(([, length, at]) => [length, at]),
    );
    expect(now.map(([id]) => id)).toEqual([
      'JUNK',
      'fmt ',
      'JUNK',
      'fact',
      'data',
      'JUNK',
      'JUNK',
      'JUNK',
    ]);
    const [, , dataAt] = now.find(([id]) => id === 'data')!;
    expect(after.subarray(dataAt + 8, dataAt + 8 + samples.length).equals(samples)).toBe(true);
    expect(after.includes(fmt)).toBe(true);
  });

  // What a recorder writing to a pipe produces: it cannot seek back to fill the
  // length in, so `data` claims 4 GiB and the audio simply runs to the end.
  it('accepts a streamed file whose data chunk claims more than the file holds', async () => {
    const original = Buffer.concat([
      riff([chunk('LIST', Buffer.from(`INFO${SECRETS[0]}`)), chunk('fmt ', fmt)]),
      chunk('data', samples, 0xffffffff),
    ]);
    const p = write('streamed.wav', original);

    await scrubMediaFile(p, 'audio/wav');
    const after = fs.readFileSync(p);

    expect(after.includes(Buffer.from(SECRETS[0]))).toBe(false);
    expect(after.length).toBe(original.length);
    expect(after.subarray(after.length - samples.length).equals(samples)).toBe(true);
  });

  it('refuses a metadata chunk that runs past the end of the file', async () => {
    const original = Buffer.concat([
      riff([chunk('fmt ', fmt)]),
      chunk('LIST', Buffer.from(`INFO${SECRETS[0]}`), 5000),
    ]);
    await expect(scrubMediaFile(write('bad.wav', original), 'audio/wav')).rejects.toBeInstanceOf(
      MediaScrubError,
    );
  });

  it('refuses a RIFF file that is not a WAV', async () => {
    const avi = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')]);
    await expect(scrubMediaFile(write('clip.avi', avi), 'audio/wav')).rejects.toBeInstanceOf(
      MediaScrubError,
    );
  });
});
