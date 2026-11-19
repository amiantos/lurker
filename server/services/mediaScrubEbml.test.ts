// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubMediaFile, MediaScrubError } from './mediaScrub.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-ebmlscrub-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

const UNKNOWN = -1;

/** An EBML size field `width` bytes wide. ffmpeg writes eight-byte sizes for the
 *  masters it has to come back and patch, so the fixtures do too. */
function sizeField(size: number, width: number): Buffer {
  if (size === UNKNOWN) {
    const out = Buffer.alloc(width, 0xff);
    out[0] = (1 << (8 - width)) | (0xff >> width);
    return out;
  }
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(size) | (1n << BigInt(7 * width)));
  return out.subarray(8 - width);
}

/** An element: id, size, payload. An id's length marker is part of its value, so
 *  its hex spelling is already its bytes. */
function el(id: number, payload: Buffer | string, width = 1, size?: number): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const idBytes = Buffer.from(id.toString(16), 'hex');
  return Buffer.concat([idBytes, sizeField(size ?? body.length, width), body]);
}

const uint = (n: number, bytes = 4) => {
  const b = Buffer.alloc(bytes);
  b.writeUIntBE(n, 0, bytes);
  return b;
};

// The ids the fixtures use. Spelled out here, independently of the scrubber's own
// table, so a wrong constant there cannot agree with a wrong constant here.
const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const SEEK_ID = 0x53ab;
const SEEK_POSITION = 0x53ac;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const MUXING_APP = 0x4d80;
const WRITING_APP = 0x5741;
const DATE_UTC = 0x4461;
const TITLE = 0x7ba9;
const SEGMENT_UID = 0x73a4;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_NAME = 0x536e;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const CLUSTER = 0x1f43b675;
const TIMESTAMP = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const CUES = 0x1c53bb6b;
const TAGS = 0x1254c367;
const ATTACHMENTS = 0x1941a469;
const CHAPTERS = 0x1043a770;
const VOID = 0xec;
const CRC32 = 0xbf;

const MASTERS = new Set([SEGMENT, SEEK_HEAD, SEEK, INFO, TRACKS, TRACK_ENTRY]);

const ebmlHeader = (docType: string) =>
  el(
    EBML,
    Buffer.concat([
      el(0x4286, uint(1, 1)),
      el(0x42f7, uint(1, 1)),
      el(0x42f2, uint(4, 1)),
      el(0x42f3, uint(8, 1)),
      el(0x4282, docType),
      el(0x4287, uint(2, 1)),
      el(0x4285, uint(2, 1)),
    ]),
  );

interface Parsed {
  id: number;
  start: number;
  data: number;
  end: number;
  children?: Parsed[];
}

/**
 * An EBML reader that shares nothing with the scrubber: the test's own answer to
 * "is this still a well-formed file, and what is in it". Strict on purpose — every
 * element must fit its parent exactly, which is what a size-preserving edit that
 * got its arithmetic wrong would break.
 */
function parse(buf: Buffer, start = 0, end = buf.length): Parsed[] {
  const out: Parsed[] = [];
  let pos = start;
  while (pos < end) {
    const idLength = Math.clz32(buf[pos]) - 23;
    const id = buf.readUIntBE(pos, idLength);
    const sizeLength = Math.clz32(buf[pos + idLength]) - 23;
    let size = buf[pos + idLength] & (0xff >> sizeLength);
    let unknown = size === 0xff >> sizeLength;
    for (let i = 1; i < sizeLength; i++) {
      const byte = buf[pos + idLength + i];
      if (byte !== 0xff) unknown = false;
      size = size * 256 + byte;
    }
    const data = pos + idLength + sizeLength;
    // The fixtures only leave Segment and Cluster unsized; a Cluster's blocks are
    // one- and two-byte ids, so it ends at the next four-byte one.
    let elementEnd = data + size;
    if (unknown) {
      elementEnd = end;
      if (id === CLUSTER) {
        let scan = data;
        while (scan < end && Math.clz32(buf[scan]) - 23 < 4) {
          const il = Math.clz32(buf[scan]) - 23;
          const sl = Math.clz32(buf[scan + il]) - 23;
          let s = buf[scan + il] & (0xff >> sl);
          for (let i = 1; i < sl; i++) s = s * 256 + buf[scan + il + i];
          scan += il + sl + s;
        }
        elementEnd = scan;
      }
    }
    if (elementEnd > end) throw new Error(`element 0x${id.toString(16)} overruns its parent`);
    const node: Parsed = { id, start: pos, data, end: elementEnd };
    if (MASTERS.has(id)) node.children = parse(buf, data, elementEnd);
    out.push(node);
    pos = elementEnd;
  }
  return out;
}

const find = (nodes: Parsed[], id: number) => nodes.filter((n) => n.id === id);
const payload = (buf: Buffer, n: Parsed) => buf.subarray(n.data, n.end);

const SECRETS = {
  title: 'Dinner at 14 Elm Street',
  location: '+37.7749-122.4194/',
  track: "Alex's Blue Yeti",
  muxer: 'Lavf60.16.100',
  writer: 'OBS Studio 30.0',
  attachment: 'cover-with-exif.jpg',
  chapter: 'Walking to the car',
};

const CLUSTER_BYTES = 4096;

/** What ffmpeg or OBS writes: every size known, eight bytes wide on the masters,
 *  metadata on both sides of the media. */
function muxedFile(docType = 'webm'): Buffer {
  const seek = (id: number, position: number) =>
    el(SEEK, Buffer.concat([el(SEEK_ID, uint(id)), el(SEEK_POSITION, uint(position))]));
  const seekHead = el(
    SEEK_HEAD,
    Buffer.concat([seek(INFO, 100), seek(TRACKS, 200), seek(TAGS, 300), seek(CUES, 400)]),
  );
  const info = el(
    INFO,
    Buffer.concat([
      el(CRC32, uint(0xdeadbeef)),
      el(TIMESTAMP_SCALE, uint(1_000_000, 3)),
      el(MUXING_APP, SECRETS.muxer),
      el(WRITING_APP, SECRETS.writer),
      el(SEGMENT_UID, Buffer.alloc(16, 0x5a)),
      el(DATE_UTC, Buffer.alloc(8, 0x11)),
      el(TITLE, SECRETS.title),
      el(DURATION, Buffer.from([0x45, 0x9c, 0x40, 0x00])), // float 5000.0
    ]),
    8,
  );
  const tracks = el(
    TRACKS,
    el(
      TRACK_ENTRY,
      Buffer.concat([
        el(TRACK_NUMBER, uint(1, 1)),
        el(TRACK_NAME, SECRETS.track),
        el(CODEC_ID, 'A_OPUS'),
        el(CODEC_PRIVATE, Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11, 1)])),
      ]),
    ),
    8,
  );
  const tags = el(TAGS, Buffer.concat([Buffer.from('LOCATION'), Buffer.from(SECRETS.location)]), 8);
  const cluster = el(CLUSTER, Buffer.alloc(CLUSTER_BYTES, 0xab), 8);
  const cues = el(CUES, Buffer.alloc(24, 0xc5), 8);
  const attachments = el(ATTACHMENTS, SECRETS.attachment, 4);
  const chapters = el(CHAPTERS, SECRETS.chapter, 1);
  return Buffer.concat([
    ebmlHeader(docType),
    el(
      SEGMENT,
      Buffer.concat([seekHead, info, tracks, tags, cluster, cues, attachments, chapters]),
      8,
    ),
  ]);
}

describe('scrubMediaFile — Matroska / WebM', () => {
  it('removes every identifying string and never changes the file length', async () => {
    const original = muxedFile();
    const p = write('muxed.webm', original);
    for (const s of Object.values(SECRETS)) expect(original.includes(Buffer.from(s))).toBe(true);

    await scrubMediaFile(p, 'video/webm');
    const after = fs.readFileSync(p);

    for (const s of Object.values(SECRETS)) expect(after.includes(Buffer.from(s))).toBe(false);
    expect(after.includes(Buffer.from('LOCATION'))).toBe(false);
    expect(after.length).toBe(original.length);
  });

  it('leaves a file an independent reader still parses, with nothing moved', async () => {
    const original = muxedFile();
    const p = write('structure.webm', original);
    await scrubMediaFile(p, 'video/webm');
    const after = fs.readFileSync(p);

    // parse() throws if any element no longer fits its parent exactly.
    const [, before] = parse(original);
    const [, segment] = parse(after);

    // Every top-level element is where it was: SeekHead and Cues hold absolute
    // offsets, so this is the property that keeps the file seekable.
    expect(segment.children!.map((c) => [c.start, c.end])).toEqual(
      before.children!.map((c) => [c.start, c.end]),
    );
    // Tags, Attachments and Chapters are now Void; the rest kept their identity.
    expect(segment.children!.map((c) => c.id)).toEqual([
      SEEK_HEAD,
      INFO,
      TRACKS,
      VOID,
      CLUSTER,
      CUES,
      VOID,
      VOID,
    ]);
    // The media and its index are byte-identical.
    for (const id of [CLUSTER, CUES]) {
      const [a] = find(segment.children!, id);
      expect(after.subarray(a.start, a.end).equals(original.subarray(a.start, a.end))).toBe(true);
    }
  });

  it('keeps what a player needs from Info and empties the rest', async () => {
    const original = muxedFile();
    const p = write('info.webm', original);
    await scrubMediaFile(p, 'video/webm');
    const after = fs.readFileSync(p);
    const [info] = find(parse(after)[1].children!, INFO);

    const [scale] = find(info.children!, TIMESTAMP_SCALE);
    expect(payload(after, scale).readUIntBE(0, 3)).toBe(1_000_000);
    const [duration] = find(info.children!, DURATION);
    expect(payload(after, duration).readFloatBE(0)).toBe(5000);

    // Mandatory elements stay, as empty strings (all padding).
    for (const id of [MUXING_APP, WRITING_APP]) {
      const [app] = find(info.children!, id);
      expect(payload(after, app).every((b) => b === 0)).toBe(true);
    }
    // The optional ones are gone, and so is the checksum that covered them.
    for (const id of [TITLE, DATE_UTC, SEGMENT_UID, CRC32]) {
      expect(find(info.children!, id)).toEqual([]);
    }
  });

  it('voids a track name but not the codec data a decoder needs', async () => {
    const original = muxedFile();
    const p = write('tracks.webm', original);
    await scrubMediaFile(p, 'video/webm');
    const after = fs.readFileSync(p);
    const [tracks] = find(parse(after)[1].children!, TRACKS);
    const entry = tracks.children![0];

    expect(find(entry.children!, TRACK_NAME)).toEqual([]);
    expect(payload(after, find(entry.children!, CODEC_ID)[0]).toString()).toBe('A_OPUS');
    const [priv] = find(entry.children!, CODEC_PRIVATE);
    expect(payload(after, priv).equals(original.subarray(priv.data, priv.end))).toBe(true);
  });

  it('drops the SeekHead entries that pointed at what it removed, and only those', async () => {
    const p = write('seek.webm', muxedFile());
    await scrubMediaFile(p, 'video/webm');
    const after = fs.readFileSync(p);
    const [seekHead] = find(parse(after)[1].children!, SEEK_HEAD);

    const targets = find(seekHead.children!, SEEK).map((s) =>
      payload(after, find(s.children!, SEEK_ID)[0]).readUInt32BE(0),
    );
    expect(targets).toEqual([INFO, TRACKS, CUES]);
  });

  it('treats Matroska as the same container', async () => {
    const original = muxedFile('matroska');
    const p = write('muxed.mkv', original);
    await scrubMediaFile(p, 'video/matroska');
    const after = fs.readFileSync(p);
    for (const s of Object.values(SECRETS)) expect(after.includes(Buffer.from(s))).toBe(false);
    expect(after.length).toBe(original.length);
  });

  // What a browser's MediaRecorder and a GNOME screencast actually write: nothing
  // has a size, because the recorder never knew how long it would run. The only way
  // past a cluster is over each of its blocks, and the metadata a later remux
  // appended sits beyond all of them.
  it('walks a live recording, where neither Segment nor Cluster says how long it is', async () => {
    const block = (fill: number) =>
      el(
        SIMPLE_BLOCK,
        Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), Buffer.alloc(900, fill)]),
        2,
      );
    const cluster = (fill: number) =>
      el(
        CLUSTER,
        Buffer.concat([el(TIMESTAMP, uint(0, 1)), block(fill), block(fill + 1), block(fill + 2)]),
        8,
        UNKNOWN,
      );
    const info = el(
      INFO,
      Buffer.concat([el(TIMESTAMP_SCALE, uint(1_000_000, 3)), el(MUXING_APP, 'Chrome')]),
    );
    const tags = el(TAGS, Buffer.concat([Buffer.from('LOCATION'), Buffer.from(SECRETS.location)]));
    const original = Buffer.concat([
      ebmlHeader('webm'),
      el(SEGMENT, Buffer.concat([info, cluster(0x10), cluster(0x20), tags]), 8, UNKNOWN),
    ]);
    const p = write('live.webm', original);

    await scrubMediaFile(p, 'video/webm');
    const after = fs.readFileSync(p);

    expect(after.includes(Buffer.from(SECRETS.location))).toBe(false);
    expect(after.includes(Buffer.from('Chrome'))).toBe(false);
    expect(after.length).toBe(original.length);
    // The Void that replaced Tags now reads as the tail of the last cluster — a
    // cluster with no size runs until something that cannot be inside one, and
    // padding can. Which is fine: it is skipped there as it would be anywhere.
    expect(parse(after)[1].children!.map((c) => c.id)).toEqual([INFO, CLUSTER, CLUSTER]);
    const clusters = find(parse(original)[1].children!, CLUSTER);
    expect(clusters.length).toBe(2);
    for (const c of clusters) {
      expect(after.subarray(c.start, c.end).equals(original.subarray(c.start, c.end))).toBe(true);
    }
  });

  it('accepts a recording that was cut off mid-cluster', async () => {
    const whole = muxedFile();
    const clusterAt = whole.indexOf(Buffer.from('1f43b675', 'hex'));
    const original = whole.subarray(0, clusterAt + 12 + 100); // header + a little media
    const p = write('cutoff.webm', original);

    await scrubMediaFile(p, 'video/webm');
    const after = fs.readFileSync(p);
    expect(after.includes(Buffer.from(SECRETS.title))).toBe(false);
    expect(after.subarray(clusterAt).equals(original.subarray(clusterAt))).toBe(true);
  });

  // A Vorbis track keeps its three Ogg headers as codec data, and the middle one is
  // the comment header. Remuxing a tagged .ogg with `-c copy` carries the tags along
  // in here, where no Matroska-level scrub would ever look.
  it('empties the comment header inside a Vorbis track, in place', async () => {
    const id = Buffer.concat([Buffer.from('\x01vorbis', 'latin1'), Buffer.alloc(23, 2)]);
    const artist = 'ARTIST=Someone Identifiable';
    const comments = Buffer.concat([
      Buffer.from('\x03vorbis', 'latin1'),
      uint(0x06000000), // vendor_length 6, little-endian
      Buffer.from('Xiph.O'),
      uint(0x01000000),
      uint(artist.length << 24),
      Buffer.from(artist),
      Buffer.from([1]),
    ]);
    const setup = Buffer.concat([Buffer.from('\x05vorbis', 'latin1'), Buffer.alloc(600, 0x77)]);
    const lacing = Buffer.from([2, id.length, comments.length]);
    const codecPrivate = Buffer.concat([lacing, id, comments, setup]);
    const tracks = el(
      TRACKS,
      el(
        TRACK_ENTRY,
        // CodecPrivate BEFORE CodecID: element order inside a master is not fixed.
        Buffer.concat([el(CODEC_PRIVATE, codecPrivate, 2), el(CODEC_ID, 'A_VORBIS')]),
        2,
      ),
      2,
    );
    const original = Buffer.concat([ebmlHeader('webm'), el(SEGMENT, tracks, 8)]);
    const p = write('vorbis.webm', original);

    await scrubMediaFile(p, 'video/webm');
    const after = fs.readFileSync(p);

    expect(after.includes(Buffer.from('Someone Identifiable'))).toBe(false);
    expect(after.includes(Buffer.from('Xiph.O'))).toBe(false);
    expect(after.length).toBe(original.length);
    // The identification and setup headers — the two a decoder reads — are intact,
    // and the comment header is still a comment header: empty vendor, no comments,
    // framing bit set.
    expect(after.includes(id)).toBe(true);
    expect(after.includes(setup)).toBe(true);
    const at = after.indexOf(Buffer.from('\x03vorbis', 'latin1'));
    expect(after.subarray(at + 7, at + 16).equals(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 1]))).toBe(
      true,
    );
  });

  it('neutralizes the tag and picture blocks inside a FLAC track', async () => {
    const blockOf = (type: number, body: Buffer, last = false) =>
      Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type]), uint(body.length, 3), body]);
    const streamInfo = blockOf(0, Buffer.alloc(34, 3));
    const codecPrivate = Buffer.concat([
      Buffer.from('fLaC'),
      streamInfo,
      blockOf(4, Buffer.from('ARTIST=Someone Identifiable')),
      blockOf(6, Buffer.from('cover.jpg with EXIF GPS'), true),
    ]);
    const tracks = el(
      TRACKS,
      el(TRACK_ENTRY, Buffer.concat([el(CODEC_ID, 'A_FLAC'), el(CODEC_PRIVATE, codecPrivate)]), 2),
      2,
    );
    const original = Buffer.concat([ebmlHeader('matroska'), el(SEGMENT, tracks, 8)]);
    const p = write('flac.mka', original);

    await scrubMediaFile(p, 'video/matroska');
    const after = fs.readFileSync(p);

    expect(after.includes(Buffer.from('Someone Identifiable'))).toBe(false);
    expect(after.includes(Buffer.from('EXIF GPS'))).toBe(false);
    expect(after.includes(streamInfo)).toBe(true);
    expect(after.length).toBe(original.length);
  });

  it('refuses a file whose metadata element runs past the end, rather than passing it on', async () => {
    const whole = muxedFile();
    const tagsAt = whole.indexOf(Buffer.from('1254c367', 'hex'));
    const p = write('truncated-tags.webm', whole.subarray(0, tagsAt + 20));
    await expect(scrubMediaFile(p, 'video/webm')).rejects.toBeInstanceOf(MediaScrubError);
  });

  it('refuses bytes that are not EBML at all', async () => {
    const p = write('not.webm', Buffer.from('this is not a matroska file, whatever it says'));
    await expect(scrubMediaFile(p, 'video/webm')).rejects.toBeInstanceOf(MediaScrubError);
  });
  // A Void is skipped by every reader, so nothing has ever checked what is in one.
  // A tool that removed Tags the way this scrubber does — retype, same length —
  // without zeroing would leave the tags sitting there.
  it('empties the Void elements a file came with, wherever the walk reaches', async () => {
    const stale = (where: string) => el(VOID, `LOCATION=${SECRETS.location} in ${where}`);
    const block = el(
      SIMPLE_BLOCK,
      Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), Buffer.alloc(60, 9)]),
    );
    const info = el(INFO, Buffer.concat([el(TIMESTAMP_SCALE, uint(1_000_000, 3)), stale('info')]));
    const tracks = el(
      TRACKS,
      Buffer.concat([
        stale('tracks'),
        el(TRACK_ENTRY, Buffer.concat([el(TRACK_NUMBER, uint(1, 1)), stale('entry')])),
      ]),
    );
    const seekHead = el(SEEK_HEAD, stale('seekhead'));
    const cluster = el(
      CLUSTER,
      Buffer.concat([el(TIMESTAMP, uint(0, 1)), block, stale('cluster'), block]),
      8,
      UNKNOWN,
    );
    const original = Buffer.concat([
      ebmlHeader('webm'),
      el(SEGMENT, Buffer.concat([seekHead, info, stale('segment'), tracks, cluster]), 8, UNKNOWN),
    ]);
    const p = write('stale-void.webm', original);
    expect(original.includes(Buffer.from(SECRETS.location))).toBe(true);

    await scrubMediaFile(p, 'video/webm');
    const after = fs.readFileSync(p);

    expect(after.includes(Buffer.from(SECRETS.location))).toBe(false);
    expect(after.includes(Buffer.from('LOCATION'))).toBe(false);
    expect(after.length).toBe(original.length);
    // Every element is where it was and what it was; only Void payloads changed.
    const shape = (nodes: Parsed[]): unknown[] =>
      nodes.map((n) => [n.id, n.start, n.end, n.children && shape(n.children)]);
    expect(shape(parse(after))).toEqual(shape(parse(original)));
    expect(after.includes(block)).toBe(true);
  });
});
