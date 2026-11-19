// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubMediaFile, MediaScrubError } from './mediaScrub.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-oggscrub-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

/**
 * Ogg's checksum, one bit at a time. Deliberately NOT the scrubber's table-driven
 * one: a shared implementation would agree with itself however wrong it was, and a
 * wrong checksum is the one way this scrubber can silently break a file — a decoder
 * drops the page.
 */
function crc(bytes: Buffer): number {
  let r = 0;
  for (const byte of bytes) {
    r ^= byte << 24;
    for (let i = 0; i < 8; i++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  }
  return r >>> 0;
}

const BOS = 0x02;
const CONTINUED = 0x01;

/** One page from a lacing table and its body. */
function page(serial: number, sequence: number, flags: number, lacing: number[], body: Buffer) {
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'latin1');
  header[5] = flags;
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = lacing.length;
  Buffer.from(lacing).copy(header, 27);
  const out = Buffer.concat([header, body]);
  out.writeUInt32LE(crc(out), 22);
  return out;
}

/**
 * Lay packets out in pages the way a muxer does: a packet is cut into 255-byte
 * segments, and a page takes at most `perPage` of them, so a long packet runs on
 * into pages flagged as continuations.
 */
function paginate(serial: number, packets: Buffer[], firstSequence: number, perPage = 255) {
  const segments: { bytes: Buffer; startsPacket: boolean }[] = [];
  for (const packet of packets) {
    let at = 0;
    let first = true;
    for (;;) {
      const bytes = packet.subarray(at, at + 255);
      segments.push({ bytes, startsPacket: first });
      first = false;
      at += 255;
      if (bytes.length < 255) break;
    }
  }
  const pages: Buffer[] = [];
  for (let i = 0; i < segments.length; i += perPage) {
    const slice = segments.slice(i, i + perPage);
    const flags =
      (firstSequence + pages.length === 0 ? BOS : 0) | (slice[0].startsPacket ? 0 : CONTINUED);
    pages.push(
      page(
        serial,
        firstSequence + pages.length,
        flags,
        slice.map((s) => s.bytes.length),
        Buffer.concat(slice.map((s) => s.bytes)),
      ),
    );
  }
  return pages;
}

/** Read a file back as pages, checking every checksum, and reassemble each
 *  stream's packets. The test's own reader — nothing here is the scrubber's. */
function readStreams(buf: Buffer): Map<number, Buffer[]> {
  const streams = new Map<number, Buffer[]>();
  const partial = new Map<number, Buffer[]>();
  let pos = 0;
  while (pos < buf.length) {
    expect(buf.toString('latin1', pos, pos + 4)).toBe('OggS');
    const serial = buf.readUInt32LE(pos + 14);
    const count = buf[pos + 26];
    const lacing = [...buf.subarray(pos + 27, pos + 27 + count)];
    const bodyStart = pos + 27 + count;
    const end = bodyStart + lacing.reduce((a, b) => a + b, 0);

    const whole = Buffer.from(buf.subarray(pos, end));
    const stored = whole.readUInt32LE(22);
    whole.writeUInt32LE(0, 22);
    expect({ pos, crc: crc(whole) }).toEqual({ pos, crc: stored });

    let at = bodyStart;
    for (const value of lacing) {
      const parts = partial.get(serial) ?? [];
      parts.push(buf.subarray(at, at + value));
      partial.set(serial, parts);
      at += value;
      if (value < 255) {
        streams.set(serial, [...(streams.get(serial) ?? []), Buffer.concat(parts)]);
        partial.set(serial, []);
      }
    }
    pos = end;
  }
  return streams;
}

const le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

const VENDOR = 'Lavf60.16.100 on alexs-laptop';
const TAGS = ['ARTIST=Someone Identifiable', 'LOCATION=+37.7749-122.4194/'];

/** vendor, count, comments — the structure all four codecs share. `extra` pads it
 *  out the way an embedded cover image does. */
function commentBody(extra = 0): Buffer {
  const tags = extra ? [...TAGS, `METADATA_BLOCK_PICTURE=${'A'.repeat(extra)}`] : TAGS;
  return Buffer.concat([
    le(VENDOR.length),
    Buffer.from(VENDOR),
    le(tags.length),
    ...tags.flatMap((t) => [le(t.length), Buffer.from(t)]),
  ]);
}

const latin = (s: string) => Buffer.from(s, 'latin1');

const vorbisId = Buffer.concat([latin('\x01vorbis'), Buffer.alloc(23, 2)]);
const vorbisSetup = Buffer.concat([latin('\x05vorbis'), Buffer.alloc(3000, 0x77)]);
const vorbisComments = (extra = 0) =>
  Buffer.concat([latin('\x03vorbis'), commentBody(extra), Buffer.from([1])]);
const audio = (fill: number) => Buffer.alloc(700, fill);

function vorbisFile(serial = 0x1234, extra = 0): Buffer {
  return Buffer.concat([
    ...paginate(serial, [vorbisId], 0),
    // Comments and setup share pages, as libvorbis writes them.
    ...paginate(serial, [vorbisComments(extra), vorbisSetup], 1, 40),
    ...paginate(serial, [audio(0xa1), audio(0xa2), audio(0xa3)], 50),
  ]);
}

function expectClean(after: Buffer): void {
  expect(after.includes(Buffer.from(VENDOR))).toBe(false);
  for (const t of TAGS) expect(after.includes(Buffer.from(t))).toBe(false);
}

describe('scrubMediaFile — Ogg', () => {
  it('empties a Vorbis comment header and keeps every page where it was', async () => {
    const original = vorbisFile();
    const p = write('tagged.ogg', original);
    expect(original.includes(Buffer.from(TAGS[1]))).toBe(true);

    await scrubMediaFile(p, 'audio/ogg');
    const after = fs.readFileSync(p);

    expectClean(after);
    expect(after.length).toBe(original.length);

    // readStreams verifies every page checksum on the way through.
    const [before] = [...readStreams(original).values()];
    const [packets] = [...readStreams(after).values()];
    expect(packets.length).toBe(before.length);
    // Still a comment header a decoder accepts: its magic, an empty vendor, no
    // comments, and the framing bit Vorbis requires right after them.
    expect(packets[1].length).toBe(before[1].length);
    expect(
      packets[1]
        .subarray(0, 16)
        .equals(Buffer.concat([latin('\x03vorbis'), Buffer.alloc(8), Buffer.from([1])])),
    ).toBe(true);
    expect(packets[1].subarray(16).every((b) => b === 0)).toBe(true);
    // Identification, setup and audio are byte-identical.
    for (const i of [0, 2, 3, 4, 5]) expect(packets[i].equals(before[i])).toBe(true);
  });

  // An embedded cover image makes the comment packet megabytes long. Here it only
  // has to be longer than one page can hold (255 segments) to prove the packet is
  // reassembled across pages and every one of them is re-checksummed.
  it('handles a comment header that spans many pages', async () => {
    const original = vorbisFile(0x1234, 90_000);
    const p = write('cover.ogg', original);

    await scrubMediaFile(p, 'audio/ogg');
    const after = fs.readFileSync(p);

    expectClean(after);
    expect(after.includes(Buffer.from('METADATA_BLOCK_PICTURE'))).toBe(false);
    expect(after.length).toBe(original.length);
    const [before] = [...readStreams(original).values()];
    const [packets] = [...readStreams(after).values()];
    expect(packets[1].length).toBeGreaterThan(90_000);
    expect(packets[2].equals(before[2])).toBe(true); // the setup header after it
  });

  it('empties OpusTags', async () => {
    const head = Buffer.concat([latin('OpusHead'), Buffer.alloc(11, 1)]);
    const tags = Buffer.concat([latin('OpusTags'), commentBody()]);
    const original = Buffer.concat([
      ...paginate(7, [head], 0),
      ...paginate(7, [tags], 1),
      ...paginate(7, [audio(0xb1), audio(0xb2)], 2),
    ]);
    const p = write('voice.opus', original);

    await scrubMediaFile(p, 'audio/ogg');
    const after = fs.readFileSync(p);

    expectClean(after);
    expect(after.length).toBe(original.length);
    const [packets] = [...readStreams(after).values()];
    expect(packets[0].equals(head)).toBe(true);
    expect(packets[1].subarray(0, 8).toString('latin1')).toBe('OpusTags');
    // Zero padding after an empty comment list: RFC 7845 §5.2 lets a reader skip it.
    expect(packets[1].subarray(8).every((b) => b === 0)).toBe(true);
    expect(packets[2].equals(audio(0xb1))).toBe(true);
  });

  it('cleans every stream of a video file (Theora + Vorbis, interleaved)', async () => {
    const theoraId = Buffer.concat([latin('\x80theora'), Buffer.alloc(35, 4)]);
    const theoraComments = Buffer.concat([latin('\x81theora'), commentBody()]);
    const theoraSetup = Buffer.concat([latin('\x82theora'), Buffer.alloc(900, 0x66)]);
    const original = Buffer.concat([
      // Both streams begin before either continues — how a multiplexed file opens.
      ...paginate(1, [theoraId], 0),
      ...paginate(2, [vorbisId], 0),
      ...paginate(1, [theoraComments, theoraSetup], 1),
      ...paginate(2, [vorbisComments(), vorbisSetup], 1),
      ...paginate(1, [audio(0xc1)], 2),
      ...paginate(2, [audio(0xc2)], 2),
    ]);
    const p = write('clip.ogv', original);

    await scrubMediaFile(p, 'video/ogg');
    const after = fs.readFileSync(p);

    expectClean(after);
    expect(after.length).toBe(original.length);
    const streams = readStreams(after);
    expect(streams.get(1)![2].equals(theoraSetup)).toBe(true);
    expect(streams.get(2)![2].equals(vorbisSetup)).toBe(true);
  });

  it('empties the bare comment packet Speex uses', async () => {
    const head = Buffer.concat([latin('Speex   '), Buffer.alloc(72, 1)]);
    const original = Buffer.concat([
      ...paginate(9, [head], 0),
      ...paginate(9, [commentBody()], 1),
      ...paginate(9, [audio(0xd1)], 2),
    ]);
    const p = write('voice.spx', original);

    await scrubMediaFile(p, 'audio/ogg');
    const after = fs.readFileSync(p);
    expectClean(after);
    expect(readStreams(after).size).toBe(1); // and every checksum on the way
  });

  // One recording appended to another — what capturing an internet radio stream
  // produces. The second link has comments of its own, far from the top of the file.
  it('cleans the second link of a chained file', async () => {
    const original = Buffer.concat([vorbisFile(0x1111), vorbisFile(0x2222)]);
    const p = write('chained.ogg', original);

    await scrubMediaFile(p, 'audio/ogg');
    const after = fs.readFileSync(p);

    expectClean(after);
    expect(readStreams(after).size).toBe(2);
  });

  // file-type calls FLAC-in-Ogg `audio/ogg`, same as Vorbis, so the classifier lets
  // it this far. Its metadata is spread over several packets this walker does not
  // read, so the answer has to be no — not "the second packet looked fine".
  it('refuses a codec it has no rule for', async () => {
    const flacId = Buffer.concat([latin('\x7fFLAC'), Buffer.alloc(46, 1)]);
    const original = Buffer.concat([
      ...paginate(3, [flacId], 0),
      ...paginate(3, [Buffer.from('ARTIST=Someone Identifiable')], 1),
    ]);
    await expect(scrubMediaFile(write('flac.oga', original), 'audio/ogg')).rejects.toBeInstanceOf(
      MediaScrubError,
    );
  });

  it('refuses a file that ends before a stream reaches its comments', async () => {
    const original = Buffer.concat(paginate(5, [vorbisId], 0));
    await expect(scrubMediaFile(write('stub.ogg', original), 'audio/ogg')).rejects.toBeInstanceOf(
      MediaScrubError,
    );
  });

  it('refuses bytes between pages rather than skipping them', async () => {
    const whole = vorbisFile();
    const firstPage = paginate(0x1234, [vorbisId], 0)[0].length;
    const original = Buffer.concat([
      whole.subarray(0, firstPage),
      Buffer.from('ID3 something a tagger wedged in'),
      whole.subarray(firstPage),
    ]);
    await expect(scrubMediaFile(write('junk.ogg', original), 'audio/ogg')).rejects.toBeInstanceOf(
      MediaScrubError,
    );
  });
});
