// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import sharp from 'sharp';
import yauzl from 'yauzl';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('../db/index.js').default;
let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let upsertChannel: typeof import('../db/networks.js').upsertChannel;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let setUserSetting: typeof import('../db/settings.js').setUserSetting;
let createRule: typeof import('../db/highlightRules.js').createRule;
let setNote: typeof import('../db/nickNotes.js').setNote;
let pinBuffer: typeof import('../db/pinnedBuffers.js').pinBuffer;
let addRule: typeof import('../db/ignoredMasks.js').addRule;
let addBookmark: typeof import('../db/bookmarks.js').addBookmark;
// Seed an ALL-level ignore the way the pre-#301 addMask helper did.
function addMask(args: { userId: number; networkId: number; mask: string }) {
  return addRule({
    userId: args.userId,
    networkId: args.networkId,
    rule: {
      mask: args.mask,
      channels: null,
      pattern: null,
      patternKind: 'substr',
      levels: ['ALL'],
      isExcept: false,
      expiresAt: null,
    },
  });
}
let insertUpload: typeof import('../db/uploadHistory.js').insertUpload;
let buildExportZip: typeof import('./exportService.js').buildExportZip;
let buildExportFilename: typeof import('./exportService.js').buildExportFilename;
let computeExportPreview: typeof import('./exportService.js').computeExportPreview;
let EXPORT_FORMAT_VERSION: typeof import('../db/exportSchema.js').EXPORT_FORMAT_VERSION;

beforeAll(async () => {
  db = (await import('../db/index.js')).default;
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork, upsertChannel } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  ({ insertUpload } = await import('../db/uploadHistory.js'));
  ({ setUserSetting } = await import('../db/settings.js'));
  ({ createRule } = await import('../db/highlightRules.js'));
  ({ setNote } = await import('../db/nickNotes.js'));
  ({ pinBuffer } = await import('../db/pinnedBuffers.js'));
  ({ addRule } = await import('../db/ignoredMasks.js'));
  ({ addBookmark } = await import('../db/bookmarks.js'));
  ({ buildExportZip, buildExportFilename, computeExportPreview } =
    await import('./exportService.js'));
  ({ EXPORT_FORMAT_VERSION } = await import('../db/exportSchema.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readZipToMap(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map<string, Buffer>();
      zip.readEntry();
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) return reject(e2);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolve(out));
    });
  });
}

async function runExport(userId: number, opts: { includeMessages: boolean }): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  await buildExportZip(db, userId, opts, sink);
  return Buffer.concat(chunks);
}

describe('buildExportZip', () => {
  let alice: User;
  let aliceNetA: Network;
  let aliceMsg1: { id: number | bigint; alt: boolean };

  beforeAll(async () => {
    alice = createUser('alice');
    aliceNetA = createNetwork(alice.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'alice',
    }) as Network;
    upsertChannel(aliceNetA.id, '#general', true);

    aliceMsg1 = insertMessage({
      networkId: aliceNetA.id,
      target: '#general',
      time: '2026-05-17T10:00:00Z',
      type: 'message',
      nick: 'alice',
      text: 'hello world',
      self: true,
    });
    insertMessage({
      networkId: aliceNetA.id,
      target: '#general',
      time: '2026-05-17T10:01:00Z',
      type: 'message',
      nick: 'bob',
      text: 'hi alice',
      self: false,
    });

    setUserSetting(alice.id, 'appearance.theme.name', 'dark');
    createRule(alice.id, { pattern: 'alice', kind: 'plain', case_sensitive: false });
    setNote({ userId: alice.id, networkId: aliceNetA.id, nick: 'bob', note: 'lives in berlin' });
    addMask({ userId: alice.id, networkId: aliceNetA.id, mask: 'spammer!*@*' });
    pinBuffer(alice.id, aliceNetA.id, '#general');
    addBookmark(alice.id, aliceMsg1.id as number);

    // upload_history with a thumbnail blob
    insertUpload(alice.id, {
      provider: 'hoarder',
      url: 'https://example.com/foo.jpg',
      filename: 'foo.jpg',
      mime: 'image/jpeg',
      byte_size: 1234,
      width: 100,
      height: 100,
      thumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
    });
  });

  it('includes manifest.json with format version and counts', async () => {
    const buf = await runExport(alice.id, { includeMessages: false });
    const entries = await readZipToMap(buf);
    expect(entries.has('manifest.json')).toBe(true);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
      export_format_version: number;
      source_user_id: number;
      sections: string[];
      counts: Record<string, number>;
    };
    expect(manifest.export_format_version).toBe(EXPORT_FORMAT_VERSION);
    expect(manifest.source_user_id).toBe(alice.id);
    expect(manifest.sections).toContain('data');
    expect(manifest.sections).not.toContain('messages');
    expect(manifest.counts.networks).toBe(1);
    expect(manifest.counts.messages).toBe(0);
  });

  it('omits messages.ndjson and bookmarks.json when includeMessages is false', async () => {
    const buf = await runExport(alice.id, { includeMessages: false });
    const entries = await readZipToMap(buf);
    expect(entries.has('messages.ndjson')).toBe(false);
    expect(entries.has('bookmarks.json')).toBe(false);
  });

  it('includes messages.ndjson and bookmarks.json when includeMessages is true', async () => {
    const buf = await runExport(alice.id, { includeMessages: true });
    const entries = await readZipToMap(buf);
    expect(entries.has('messages.ndjson')).toBe(true);
    expect(entries.has('bookmarks.json')).toBe(true);

    const lines = entries.get('messages.ndjson')!.toString('utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const rows = lines.map((l) => JSON.parse(l) as { text: string });
    expect(rows[0].text).toBe('hello world');
    expect(rows[1].text).toBe('hi alice');

    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
      sections: string[];
      counts: Record<string, number>;
    };
    expect(manifest.sections).toContain('messages');
    expect(manifest.sections).toContain('bookmarks');
    expect(manifest.counts.messages).toBe(2);
  });

  it('writes data.json with networks, channels, and other per-user rows', async () => {
    const buf = await runExport(alice.id, { includeMessages: false });
    const entries = await readZipToMap(buf);
    const data = JSON.parse(entries.get('data.json')!.toString('utf8')) as {
      networks: Array<{ name: string }>;
      channels: Array<{ name: string }>;
      users: Array<{ username: string }>;
    };
    expect(data.networks.length).toBe(1);
    expect(data.networks[0].name).toBe('libera');
    expect(data.channels.length).toBe(1);
    expect(data.channels[0].name).toBe('#general');
    expect(data.users.length).toBe(1);
    expect(data.users[0].username).toBe('alice');
  });

  it('emits upload thumbnails as separate zip entries and strips the blob from data.json', async () => {
    const buf = await runExport(alice.id, { includeMessages: false });
    const entries = await readZipToMap(buf);
    const data = JSON.parse(entries.get('data.json')!.toString('utf8')) as {
      upload_history: Array<{ id: number; hasThumbnail: boolean }>;
    };
    const upload = data.upload_history[0];
    expect(upload).toBeDefined();
    expect('thumbnail' in upload).toBe(false);
    expect(upload.hasThumbnail).toBe(true);
    expect(entries.has(`thumbnails/${upload.id}.jpg`)).toBe(true);
    expect(entries.get(`thumbnails/${upload.id}.jpg`)!.length).toBeGreaterThan(0);
  });

  // Thumbnails are WebP since #560, but rows predating it are JPEG and both can
  // sit in one account — so the entry name is sniffed per blob, not assumed.
  it('names a WebP thumbnail .webp while a legacy JPEG one stays .jpg', async () => {
    const webpThumb = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .webp()
      .toBuffer();
    const webpUpload = insertUpload(alice.id, {
      provider: 'hoarder',
      url: 'https://example.com/new.webp',
      filename: 'new.webp',
      mime: 'image/webp',
      byte_size: 99,
      width: 8,
      height: 8,
      thumbnail: webpThumb,
    });

    const entries = await readZipToMap(await runExport(alice.id, { includeMessages: false }));
    expect(entries.has(`thumbnails/${webpUpload}.webp`)).toBe(true);
    // The JPEG row seeded in beforeAll is untouched by the new default.
    expect([...entries.keys()].some((k) => k.endsWith('.jpg'))).toBe(true);
  });

  it('scopes data per-user (bob does not see alice)', async () => {
    const bob = createUser('bob_scope');
    createNetwork(bob.id, {
      name: 'bobnet',
      host: 'irc.bobnet',
      port: 6697,
      tls: true,
      nick: 'bob',
    });
    const bufBob = await runExport(bob.id, { includeMessages: true });
    const entriesBob = await readZipToMap(bufBob);
    const dataBob = JSON.parse(entriesBob.get('data.json')!.toString('utf8')) as {
      networks: Array<{ name: string }>;
    };
    expect(dataBob.networks.length).toBe(1);
    expect(dataBob.networks[0].name).toBe('bobnet');
    // alice's messages don't leak.
    const lines = (entriesBob.get('messages.ndjson') || Buffer.from('')).toString('utf8').trim();
    expect(lines).toBe('');
  });
});

describe('export under concurrent IRC writes (lurker#175 regression)', () => {
  it('does not throw "database connection is busy" when the bouncer writes mid-export', async () => {
    const u = createUser('concurrent-writer');
    const net = createNetwork(u.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'c',
    }) as Network;
    // Several pages' worth (MESSAGE_PAGE = 2000) so the paged stream yields to
    // the loop multiple times, giving the writer below room to interleave.
    for (let i = 0; i < 8000; i += 1) {
      insertMessage({
        networkId: net.id,
        target: '#c',
        time: '2026-05-17T10:00:00Z',
        type: 'message',
        nick: 'c',
        text: `seed ${i}`,
        self: false,
      });
    }

    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(c));

    // Hammer the SAME shared connection the export reads from. The export pages
    // its reads with discrete `.all()` queries and never holds a cursor across
    // a yield, so these writes must not throw "database connection is busy" —
    // the crash that took the process down on the old `.iterate()` design
    // (lurker#175).
    // Finite burst: keyset pagination reads "current" rows, so an unbounded
    // writer would keep pushing ids past the cursor and the export would never
    // reach an empty page. A real bouncer writes far slower than the export
    // pages, so it always catches up; cap the burst to model that.
    const LIVE_WRITE_CAP = 200;
    let liveWrites = 0;
    let writeError: unknown = null;
    let building = true;
    const pump = (): void => {
      if (!building || liveWrites >= LIVE_WRITE_CAP) return;
      try {
        insertMessage({
          networkId: net.id,
          target: '#c',
          time: '2026-05-17T10:05:00Z',
          type: 'message',
          nick: 'c',
          text: `live ${liveWrites}`,
          self: false,
        });
        liveWrites += 1;
      } catch (e) {
        writeError = e;
        building = false;
        return;
      }
      setImmediate(pump);
    };
    setImmediate(pump);

    try {
      await buildExportZip(db, u.id, { includeMessages: true }, sink);
    } finally {
      building = false;
    }

    expect(writeError).toBeNull();
    expect(liveWrites).toBeGreaterThan(0);
    expect(Buffer.concat(chunks).slice(0, 2).toString()).toBe('PK');
  }, 15_000);
});

describe('buildExportFilename', () => {
  it('includes username and date and a settings suffix when no messages', () => {
    const name = buildExportFilename('alice', { includeMessages: false });
    expect(name).toMatch(/^lurker-export-alice-\d{8}-settings\.lurk$/);
  });
  it('omits suffix when messages are included', () => {
    const name = buildExportFilename('alice', { includeMessages: true });
    expect(name).toMatch(/^lurker-export-alice-\d{8}\.lurk$/);
  });
  it('sanitizes special chars', () => {
    const name = buildExportFilename('al ice/!.', { includeMessages: true });
    expect(name).toMatch(/^lurker-export-al_ice___-\d{8}\.lurk$/);
  });
});

describe('computeExportPreview', () => {
  it('returns 0 for messages section when includeMessages is false', () => {
    const aliceRow = db.prepare(`SELECT id FROM users WHERE username = 'alice'`).get() as {
      id: number;
    };
    const counts = computeExportPreview(db, aliceRow.id, { includeMessages: false });
    expect(counts.messages).toBe(0);
    expect(counts.networks).toBeGreaterThan(0);
  });
  it('returns real message counts when includeMessages is true', () => {
    const aliceRow = db.prepare(`SELECT id FROM users WHERE username = 'alice'`).get() as {
      id: number;
    };
    const counts = computeExportPreview(db, aliceRow.id, { includeMessages: true });
    expect(counts.messages).toBeGreaterThan(0);
  });
});
