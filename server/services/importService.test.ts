// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import sharp from 'sharp';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('../db/index.js').default;
let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let buffers: typeof import('../db/buffers.js');
let insertMessage: typeof import('../db/messages.js').insertMessage;
let setUserSetting: typeof import('../db/settings.js').setUserSetting;
let createRule: typeof import('../db/highlightRules.js').createRule;
let setNote: typeof import('../db/nickNotes.js').setNote;
let saveNetworkMetadata: typeof import('../db/networkMetadata.js').saveNetworkMetadata;
let pinBuffer: typeof import('../db/pinnedBuffers.js').pinBuffer;
let favoriteBuffer: typeof import('../db/favoriteBuffers.js').favoriteBuffer;
let addRule: typeof import('../db/ignoredMasks.js').addRule;
let addBookmark: typeof import('../db/bookmarks.js').addBookmark;
let addReaction: typeof import('../db/reactions.js').addReaction;
let removeReaction: typeof import('../db/reactions.js').removeReaction;
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
let setReadState: typeof import('../db/bufferReads.js').setReadState;
let setClearedState: typeof import('../db/bufferReads.js').setClearedState;
let getClearedState: typeof import('../db/bufferReads.js').getClearedState;
let insertUpload: typeof import('../db/uploadHistory.js').insertUpload;
let setNicklistCollapsed: typeof import('../db/nicklistCollapsed.js').setNicklistCollapsed;
let setChannelNotifyAlways: typeof import('../db/channelNotify.js').setChannelNotifyAlways;
let upsertDraft: typeof import('../db/drafts.js').upsertDraft;
let writeAwayMarker: typeof import('../db/networkAwayState.js').writeAwayMarker;
let addInputHistory: typeof import('../db/inputHistory.js').addEntry;
let EXPORT_TABLES: typeof import('../db/exportSchema.js').EXPORT_TABLES;
let buildExportZip: typeof import('./exportService.js').buildExportZip;
let importFromZipBuffer: typeof import('./importService.js').importFromZipBuffer;
let ImportError: typeof import('./importService.js').ImportError;
let EXPORT_FORMAT_VERSION: typeof import('../db/exportSchema.js').EXPORT_FORMAT_VERSION;

beforeAll(async () => {
  db = (await import('../db/index.js')).default;
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  buffers = await import('../db/buffers.js');
  ({ insertMessage } = await import('../db/messages.js'));
  ({ insertUpload } = await import('../db/uploadHistory.js'));
  ({ setUserSetting } = await import('../db/settings.js'));
  ({ createRule } = await import('../db/highlightRules.js'));
  ({ setNote } = await import('../db/nickNotes.js'));
  ({ saveNetworkMetadata } = await import('../db/networkMetadata.js'));
  ({ pinBuffer } = await import('../db/pinnedBuffers.js'));
  ({ favoriteBuffer } = await import('../db/favoriteBuffers.js'));
  ({ addRule } = await import('../db/ignoredMasks.js'));
  ({ addBookmark } = await import('../db/bookmarks.js'));
  ({ addReaction, removeReaction } = await import('../db/reactions.js'));
  ({ setReadState, setClearedState, getClearedState } = await import('../db/bufferReads.js'));
  ({ setNicklistCollapsed } = await import('../db/nicklistCollapsed.js'));
  ({ setChannelNotifyAlways } = await import('../db/channelNotify.js'));
  ({ upsertDraft } = await import('../db/drafts.js'));
  ({ writeAwayMarker } = await import('../db/networkAwayState.js'));
  const ih = await import('../db/inputHistory.js');
  addInputHistory = ih.addEntry;
  ({ buildExportZip } = await import('./exportService.js'));
  ({ importFromZipBuffer, ImportError } = await import('./importService.js'));
  ({ EXPORT_FORMAT_VERSION, EXPORT_TABLES } = await import('../db/exportSchema.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function exportToBuffer(userId: number, opts: { includeMessages: boolean }): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  await buildExportZip(db, userId, opts, sink);
  return Buffer.concat(chunks);
}

// An archive's entries, and an archive built back from them — for a test that
// edits one file of a real export.
async function unzipToMap(buf: Buffer): Promise<Map<string, Buffer>> {
  const yauzl = await import('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = new Map<string, Buffer>();
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
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
      zip.on('error', reject);
    });
  });
}

async function zipFromMap(entries: Map<string, Buffer>): Promise<Buffer> {
  const { ZipArchive } = await import('archiver');
  const archive = new ZipArchive();
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(c));
  for (const [name, content] of entries) archive.append(content, { name });
  await archive.finalize();
  return Buffer.concat(chunks);
}

function seedAlice(): { alice: User; net: Network; ruleId: number } {
  const alice = createUser(`alice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const net = createNetwork(alice.id, {
    name: 'libera',
    host: 'irc.libera.chat',
    port: 6697,
    tls: true,
    nick: 'alice',
  }) as Network;
  buffers.ensureOpen(alice.id, net.id, '#general', { kind: 'channel', autojoin: true });
  buffers.ensureOpen(alice.id, net.id, '#dev', { kind: 'channel' });
  const m1 = insertMessage({
    networkId: net.id,
    target: '#general',
    time: '2026-05-17T10:00:00Z',
    type: 'message',
    nick: 'alice',
    text: 'hello',
    self: true,
    msgid: 'seed-msgid-1',
  });
  insertMessage({
    networkId: net.id,
    target: '#general',
    time: '2026-05-17T10:01:00Z',
    type: 'message',
    nick: 'bob',
    text: 'hi alice',
    self: false,
  });
  setUserSetting(alice.id, 'appearance.theme.name', 'dark');
  const rule = createRule(alice.id, { pattern: 'alice', kind: 'plain', case_sensitive: false });
  setNote({ userId: alice.id, networkId: net.id, nick: 'bob', note: 'lives in berlin' });
  saveNetworkMetadata(alice.id, net.id, 'display-name', 'Alice A.');
  saveNetworkMetadata(alice.id, net.id, 'status', null);
  addMask({ userId: alice.id, networkId: net.id, mask: 'spammer!*@*' });
  pinBuffer(alice.id, net.id, '#general');
  favoriteBuffer(alice.id, net.id, '#general');
  addBookmark(alice.id, m1.id as number);
  setReadState(alice.id, net.id, '#general', m1.id as number);
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
  return { alice, net, ruleId: rule!.id };
}

describe('importFromZipBuffer — roundtrip', () => {
  it('restores an rfc1459 network with per-network folds — no mid-restore fork (#707)', async () => {
    // The archive carries the network's declared CASEMAPPING, and the buffer
    // rows must be re-folded under THAT rule on the way in: a legacy
    // toLowerCase here writes folds the message import's own resolver then
    // misses, minting a duplicate buffer during the restore — and the healing
    // refold never runs, because the imported mapping makes the first
    // reconnect's stored===declared check a no-op.
    const src = createUser(`refold_src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const net = createNetwork(src.id, {
      name: 'rfc1459net',
      host: 'irc.example.test',
      port: 6697,
      tls: true,
      nick: 'src',
    })!;
    buffers.ensureOpen(src.id, net.id, '#foo[bar]');
    insertMessage({
      networkId: net.id,
      target: '#foo[bar]',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'peer',
      text: 'bracket history',
    });
    const { refoldNetworkBuffers } = await import('../db/refoldBuffers.js');
    refoldNetworkBuffers(src.id, net.id, 'rfc1459');

    const dst = createUser(`refold_dst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const result = await importFromZipBuffer(
      dst.id,
      await exportToBuffer(src.id, {
        includeMessages: true,
      }),
    );
    expect(result.manifest.export_format_version).toBe(EXPORT_FORMAT_VERSION);

    const dstNet = db
      .prepare(`SELECT id, casemapping FROM networks WHERE user_id = ?`)
      .get(dst.id) as { id: number; casemapping: string | null };
    expect(dstNet.casemapping).toBe('rfc1459');
    // ONE channel row, folded under the imported mapping, holding the history.
    const rows = db
      .prepare(
        `SELECT id, target, target_folded FROM buffers WHERE network_id = ? AND kind = 'channel'`,
      )
      .all(dstNet.id) as Array<{ id: number; target: string; target_folded: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe('#foo[bar]');
    expect(rows[0].target_folded).toBe('#foo{bar}');
    const msgRows = db
      .prepare(`SELECT buffer_id FROM messages WHERE network_id = ?`)
      .all(dstNet.id) as Array<{ buffer_id: number }>;
    expect(msgRows.map((m) => m.buffer_id)).toEqual([rows[0].id]);
  });

  it('rehydrates networks, channels, messages, bookmarks, highlights, pins, notes, masks, settings, uploads', async () => {
    const { alice, net } = seedAlice();
    const bob = createUser(`bob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const buf = await exportToBuffer(alice.id, { includeMessages: true });

    const result = await importFromZipBuffer(bob.id, buf);
    expect(result.manifest.export_format_version).toBe(EXPORT_FORMAT_VERSION);

    // Bob now owns mirror copies — new ids, same payloads.
    const bobNets = db.prepare('SELECT * FROM networks WHERE user_id = ?').all(bob.id) as Array<{
      id: number;
      name: string;
    }>;
    expect(bobNets.length).toBe(1);
    expect(bobNets[0].id).not.toBe(net.id);
    expect(bobNets[0].name).toBe('libera');

    const bobChannels = db
      .prepare(`SELECT * FROM buffers WHERE network_id = ? AND kind = 'channel'`)
      .all(bobNets[0].id) as Array<{ target: string; autojoin: number }>;
    expect(bobChannels.map((c) => c.target).toSorted()).toEqual(['#dev', '#general']);
    expect(bobChannels.find((c) => c.target === '#general')!.autojoin).toBe(1);

    const bobMessages = db
      .prepare('SELECT * FROM messages WHERE network_id = ? ORDER BY id ASC')
      .all(bobNets[0].id) as Array<{ text: string; msgid: string | null }>;
    expect(bobMessages.length).toBe(2);
    expect(bobMessages.map((m) => m.text)).toEqual(['hello', 'hi alice']);
    // The IRCv3 msgid column (#450) round-trips losslessly.
    expect(bobMessages.map((m) => m.msgid)).toEqual(['seed-msgid-1', null]);

    const bobBookmarks = db
      .prepare('SELECT * FROM user_bookmarks WHERE user_id = ?')
      .all(bob.id) as Array<{ message_id: number }>;
    expect(bobBookmarks.length).toBe(1);
    // Bookmark must point to a real message owned by bob's network.
    const bookmarkedMsg = db
      .prepare('SELECT network_id FROM messages WHERE id = ?')
      .get(bobBookmarks[0].message_id) as { network_id: number };
    expect(bookmarkedMsg.network_id).toBe(bobNets[0].id);

    const bobRules = db
      .prepare('SELECT * FROM highlight_rules WHERE user_id = ?')
      .all(bob.id) as Array<{ pattern: string }>;
    expect(bobRules.length).toBe(1);
    expect(bobRules[0].pattern).toBe('alice');

    const bobPins = db
      .prepare(
        `SELECT p.network_id, b.target FROM pinned_buffers p
         JOIN buffers b ON b.id = p.buffer_id WHERE p.user_id = ?`,
      )
      .all(bob.id) as Array<{ network_id: number; target: string }>;
    expect(bobPins.length).toBe(1);
    expect(bobPins[0].network_id).toBe(bobNets[0].id);
    expect(bobPins[0].target).toBe('#general');

    // Favorites ride the same buffer_id rekey; the imported row points at
    // bob's minted #general, not alice's id.
    const bobFavorites = db
      .prepare(
        `SELECT b.network_id, b.target FROM favorite_buffers f
         JOIN buffers b ON b.id = f.buffer_id WHERE f.user_id = ?`,
      )
      .all(bob.id) as Array<{ network_id: number; target: string }>;
    expect(bobFavorites).toEqual([{ network_id: bobNets[0].id, target: '#general' }]);

    const bobMasks = db
      .prepare('SELECT * FROM ignored_masks WHERE user_id = ?')
      .all(bob.id) as Array<{ mask: string }>;
    expect(bobMasks.length).toBe(1);
    expect(bobMasks[0].mask).toBe('spammer!*@*');

    const bobNotes = db
      .prepare('SELECT * FROM user_nick_notes WHERE user_id = ?')
      .all(bob.id) as Array<{ nick: string; note: string }>;
    expect(bobNotes.length).toBe(1);
    expect(bobNotes[0].nick).toBe('bob');
    expect(bobNotes[0].note).toBe('lives in berlin');

    // Our own metadata (#1189) rides the network rekey, saved unsets and all.
    const bobMetadata = db
      .prepare('SELECT network_id, key, value FROM network_metadata WHERE user_id = ? ORDER BY key')
      .all(bob.id);
    expect(bobMetadata).toEqual([
      { network_id: bobNets[0].id, key: 'display-name', value: 'Alice A.' },
      { network_id: bobNets[0].id, key: 'status', value: null },
    ]);

    const bobSettings = db
      .prepare('SELECT * FROM user_settings WHERE user_id = ?')
      .all(bob.id) as Array<{ key: string }>;
    expect(bobSettings.length).toBe(1);
    expect(bobSettings[0].key).toBe('appearance.theme.name');

    const bobUploads = db
      .prepare('SELECT * FROM upload_history WHERE user_id = ?')
      .all(bob.id) as Array<{
      url: string;
      thumbnail: Buffer | null;
      synced_to_cp: number;
      removed: number;
    }>;
    expect(bobUploads.length).toBe(1);
    expect(bobUploads[0].url).toBe('https://example.com/foo.jpg');
    // Thumbnail blob was re-attached from the zip entry.
    expect(bobUploads[0].thumbnail).not.toBeNull();
    expect(Buffer.from(bobUploads[0].thumbnail!).length).toBeGreaterThan(0);
    expect(result.thumbnailsAttached).toBe(1);
    // synced_to_cp and removed are operational state left out of the portable
    // contract, so the imported row gets the schema defaults (0) — not a NULL
    // that would fail the NOT NULL constraint (the old-archive import hazard).
    expect(bobUploads[0].synced_to_cp).toBe(0);
    expect(bobUploads[0].removed).toBe(0);
  });

  // The export names thumbnail entries from the blob's magic bytes and the import
  // matches them by extension — two places that have to agree. Since #560 the
  // bytes are WebP, so a jpg-only regex on either side silently drops thumbnails
  // on restore. Round-trip a real WebP thumb to keep them honest.
  it('round-trips a WebP thumbnail, not just a legacy JPEG one', async () => {
    const { alice } = seedAlice();
    const webpThumb = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .webp()
      .toBuffer();
    insertUpload(alice.id, {
      provider: 'hoarder',
      url: 'https://example.com/new.webp',
      filename: 'new.webp',
      mime: 'image/webp',
      byte_size: 99,
      width: 8,
      height: 8,
      thumbnail: webpThumb,
    });

    const bob = createUser(`bob_webp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const result = await importFromZipBuffer(
      bob.id,
      await exportToBuffer(alice.id, { includeMessages: false }),
    );

    // Both thumbnails came back: the seeded JPEG and the WebP one.
    expect(result.thumbnailsAttached).toBe(2);
    const restored = db
      .prepare('SELECT thumbnail FROM upload_history WHERE user_id = ? AND mime = ?')
      .get(bob.id, 'image/webp') as { thumbnail: Buffer };
    expect(Buffer.compare(Buffer.from(restored.thumbnail), webpThumb)).toBe(0);
  });

  it('refuses to import into a non-empty account', async () => {
    const { alice } = seedAlice();
    const carol = createUser(`carol_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    createNetwork(carol.id, {
      name: 'pre-existing',
      host: 'irc.example',
      port: 6697,
      tls: true,
      nick: 'c',
    });
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    await expect(importFromZipBuffer(carol.id, buf)).rejects.toMatchObject({
      code: 'account_not_empty',
    });
  });

  it('treats an account with only auto-synced user_settings as empty', async () => {
    // Reproduces the real-world case: client auto-pushes system.timezone on
    // every bootstrap, so a brand-new account has 1 row in user_settings
    // before the user does anything. That should not block an import; the
    // imported settings replace whatever was auto-synced.
    const { alice } = seedAlice();
    const fresh = createUser(`fresh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    setUserSetting(fresh.id, 'system.timezone', 'America/Chicago');
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    const result = await importFromZipBuffer(fresh.id, buf);
    expect(result.counts.networks).toBe(1);
    // user_settings row from alice's export wins; fresh's auto-synced row gone.
    const tz = db
      .prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'system.timezone'`)
      .get(fresh.id);
    // alice didn't set timezone, so post-import there should be no row at
    // that key (the export's user_settings overwrites the table).
    expect(tz).toBeUndefined();
  });

  it('imports pre-toggle archives that omit networks.trusted_certificates', async () => {
    const { alice } = seedAlice();
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    const yauzl = await import('yauzl');
    const { ZipArchive } = await import('archiver');

    const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const out = new Map<string, Buffer>();
        zip.readEntry();
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
        zip.on('error', reject);
      });
    });

    const data = JSON.parse(entries.get('data.json')!.toString('utf8')) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    for (const row of data.networks || []) delete row.trusted_certificates;
    entries.set('data.json', Buffer.from(JSON.stringify(data)));

    const archive = new ZipArchive();
    const rebuiltChunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => rebuiltChunks.push(c));
    for (const [name, content] of entries) archive.append(content, { name });
    await archive.finalize();
    const rebuilt = Buffer.concat(rebuiltChunks);

    const target = createUser(`legacy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const result = await importFromZipBuffer(target.id, rebuilt);
    expect(result.counts.networks).toBe(1);
    const imported = db
      .prepare('SELECT trusted_certificates FROM networks WHERE user_id = ?')
      .get(target.id) as { trusted_certificates: number };
    expect(imported.trusted_certificates).toBe(1);
  });

  it('imports an archive from before a NOT NULL column existed, with the table default', async () => {
    // Every column added since an archive was written is missing from it;
    // flood_protection (#1193), position and proxy_enabled are NOT NULL and
    // take their defaults rather than refusing the row.
    const { alice } = seedAlice();
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    const yauzl = await import('yauzl');
    const { ZipArchive } = await import('archiver');

    const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const out = new Map<string, Buffer>();
        zip.readEntry();
        zip.on('entry', (entry) => {
          if (entry.fileName.endsWith('/')) return zip.readEntry();
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
        zip.on('error', reject);
      });
    });

    const data = JSON.parse(entries.get('data.json')!.toString('utf8')) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    for (const row of data.networks || []) {
      delete row.flood_protection;
      delete row.position;
      delete row.proxy_enabled;
      delete row.trusted_certificates;
    }
    entries.set('data.json', Buffer.from(JSON.stringify(data)));

    const archive = new ZipArchive();
    const rebuiltChunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => rebuiltChunks.push(c));
    for (const [name, content] of entries) archive.append(content, { name });
    await archive.finalize();
    const rebuilt = Buffer.concat(rebuiltChunks);

    const target = createUser(`older_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const result = await importFromZipBuffer(target.id, rebuilt);
    expect(result.counts.networks).toBe(1);
    const imported = db
      .prepare(
        'SELECT flood_protection, position, proxy_enabled, trusted_certificates FROM networks WHERE user_id = ?',
      )
      .get(target.id);
    expect(imported).toEqual({
      flood_protection: 1,
      position: 0,
      proxy_enabled: 0,
      trusted_certificates: 1,
    });
  });

  it('rejects malicious ignored_masks rows on import (bad regex / non-ISO expiry)', async () => {
    const { alice } = seedAlice();
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    const yauzl = await import('yauzl');
    const { ZipArchive } = await import('archiver');

    const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const out = new Map<string, Buffer>();
        zip.readEntry();
        zip.on('entry', (entry) => {
          if (entry.fileName.endsWith('/')) return zip.readEntry();
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
        zip.on('error', reject);
      });
    });

    const data = JSON.parse(entries.get('data.json')!.toString('utf8')) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    const valid = data.ignored_masks[0];
    // A raw INSERT would have stored both of these verbatim. Clone the valid row
    // (so the user_id/network_id FKs rekey) and corrupt the copies.
    data.ignored_masks.push({
      ...valid,
      id: 999999,
      mask: 'eviltimer',
      pattern_kind: 'substr',
      expires_at: 'whenever', // non-ISO → never lapses, never sweeps
    });
    data.ignored_masks.push({
      ...valid,
      id: 999998,
      mask: 'brokenregex',
      pattern: '(',
      pattern_kind: 'regex', // won't compile
      expires_at: null,
    });
    entries.set('data.json', Buffer.from(JSON.stringify(data)));

    const archive = new ZipArchive();
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c));
    for (const [name, content] of entries) archive.append(content, { name });
    await archive.finalize();
    const rebuilt = Buffer.concat(chunks);

    const target = createUser(`evil_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await importFromZipBuffer(target.id, rebuilt);

    const masks = (
      db.prepare('SELECT mask FROM ignored_masks WHERE user_id = ?').all(target.id) as Array<{
        mask: string;
      }>
    ).map((r) => r.mask);
    expect(masks).toContain('spammer!*@*'); // the valid rule imported
    expect(masks).not.toContain('brokenregex'); // invalid regex rejected
    expect(masks).not.toContain('eviltimer'); // non-ISO expiry rejected
  });

  it('imports successfully without messages section', async () => {
    const { alice } = seedAlice();
    const dave = createUser(`dave_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    const result = await importFromZipBuffer(dave.id, buf);
    expect(result.counts.messages).toBe(0);
    expect(result.counts.user_bookmarks).toBe(0);
    expect(result.counts.message_reactions).toBe(0);

    const msgs = (
      db
        .prepare(
          `
      SELECT COUNT(*) AS n FROM messages
        WHERE network_id IN (SELECT id FROM networks WHERE user_id = ?)
    `,
        )
        .get(dave.id) as { n: number }
    ).n;
    expect(msgs).toBe(0);

    const bookmarks = (
      db.prepare('SELECT COUNT(*) AS n FROM user_bookmarks WHERE user_id = ?').get(dave.id) as {
        n: number;
      }
    ).n;
    expect(bookmarks).toBe(0);

    // Networks and other settings still made it.
    const nets = (
      db.prepare('SELECT COUNT(*) AS n FROM networks WHERE user_id = ?').get(dave.id) as {
        n: number;
      }
    ).n;
    expect(nets).toBe(1);

    // buffer_reads FK to messages, so settings-only imports must skip those
    // rows cleanly instead of failing the import.
    const reads = (
      db.prepare('SELECT COUNT(*) AS n FROM buffer_reads WHERE user_id = ?').get(dave.id) as {
        n: number;
      }
    ).n;
    expect(reads).toBe(0);
  });

  // #992: a reaction lands on the imported copy of the line it was on — the
  // equivalence test can't see that, since message_id is rekeyed.
  it('puts each reaction back on its own line', async () => {
    const { alice, net } = seedAlice();
    const [hello, hi] = db
      .prepare('SELECT id FROM messages WHERE network_id = ? ORDER BY id')
      .all(net.id) as { id: number }[];
    const react = (messageId: number, nick: string, value: string, self = false) =>
      addReaction({
        messageId,
        networkId: net.id,
        nick,
        value,
        self,
        toSelf: messageId === hello.id,
        time: '2026-05-17T10:05:00Z',
      });
    react(hello.id, 'bob', '👍');
    react(hello.id, 'carol', '🎉');
    react(hi.id, 'alice', '❤️', true);

    const dave = createUser(uniqueUsername('dave'));
    const buf = await exportToBuffer(alice.id, { includeMessages: true });
    const result = await importFromZipBuffer(dave.id, buf);
    expect(result.counts.message_reactions).toBe(3);

    const landed = db
      .prepare(
        `SELECT m.text, r.nick, r.value, r.self, r.to_self, r.network_id = m.network_id AS same_net
           FROM message_reactions r JOIN messages m ON m.id = r.message_id
          WHERE m.network_id IN (SELECT id FROM networks WHERE user_id = ?)
          ORDER BY r.nick`,
      )
      .all(dave.id);
    expect(landed).toEqual([
      { text: 'hi alice', nick: 'alice', value: '❤️', self: 1, to_self: 0, same_net: 1 },
      { text: 'hello', nick: 'bob', value: '👍', self: 0, to_self: 1, same_net: 1 },
      { text: 'hello', nick: 'carol', value: '🎉', self: 0, to_self: 1, same_net: 1 },
    ]);
  });

  // A reaction whose line isn't in the archive has nothing to stand on.
  it('drops a reaction whose line didn’t make the trip', async () => {
    const { alice, net } = seedAlice();
    const [hello] = db
      .prepare('SELECT id FROM messages WHERE network_id = ? ORDER BY id')
      .all(net.id) as { id: number }[];
    addReaction({
      messageId: hello.id,
      networkId: net.id,
      nick: 'bob',
      value: '👍',
      self: false,
      toSelf: true,
      time: '2026-05-17T10:05:00Z',
    });
    const buf = await exportToBuffer(alice.id, { includeMessages: true });
    // The same archive with the line gone from messages.ndjson.
    const entries = await unzipToMap(buf);
    const kept = entries
      .get('messages.ndjson')!
      .toString('utf8')
      .split('\n')
      .filter((l) => l && (JSON.parse(l) as { id: number }).id !== hello.id);
    entries.set('messages.ndjson', Buffer.from(kept.join('\n') + '\n'));

    const dave = createUser(uniqueUsername('dave'));
    const result = await importFromZipBuffer(dave.id, await zipFromMap(entries));
    expect(result.counts.message_reactions).toBe(0);
    expect(result.counts.messages).toBe(1);
  });

  // An edited archive: a duplicate is skipped as the live insert skips one,
  // instead of failing the whole import, and nick_folded is recomputed from
  // the nick, so Bob's unreact still finds his reaction.
  it('skips a duplicate reaction and recomputes nick_folded', async () => {
    const { alice, net } = seedAlice();
    const [hello] = db
      .prepare('SELECT id FROM messages WHERE network_id = ? ORDER BY id')
      .all(net.id) as { id: number }[];
    addReaction({
      messageId: hello.id,
      networkId: net.id,
      nick: 'Bob',
      value: '👍',
      self: false,
      toSelf: true,
      time: '2026-05-17T10:05:00Z',
    });
    const entries = await unzipToMap(await exportToBuffer(alice.id, { includeMessages: true }));
    const rows = JSON.parse(entries.get('reactions.json')!.toString('utf8')) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    rows[0].nick_folded = 'robert';
    rows.push({ ...rows[0] });
    entries.set('reactions.json', Buffer.from(JSON.stringify(rows)));

    const dave = createUser(uniqueUsername('dave'));
    const result = await importFromZipBuffer(dave.id, await zipFromMap(entries));
    expect(result.counts.message_reactions).toBe(1);
    expect(result.counts.messages).toBe(2);
    const landed = db
      .prepare(
        `SELECT r.nick, r.nick_folded FROM message_reactions r
          WHERE r.network_id IN (SELECT id FROM networks WHERE user_id = ?)`,
      )
      .all(dave.id);
    expect(landed).toEqual([{ nick: 'Bob', nick_folded: 'bob' }]);
  });

  it('keeps buffer_reads when messages are included', async () => {
    const { alice } = seedAlice();
    const ed = createUser(`ed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const buf = await exportToBuffer(alice.id, { includeMessages: true });
    await importFromZipBuffer(ed.id, buf);
    const reads = db.prepare('SELECT * FROM buffer_reads WHERE user_id = ?').all(ed.id) as Array<{
      last_read_message_id: number;
    }>;
    expect(reads.length).toBe(1);
    // last_read_message_id points to a message that exists in this DB.
    const msg = db
      .prepare('SELECT id FROM messages WHERE id = ?')
      .get(reads[0].last_read_message_id);
    expect(msg).toBeDefined();
  });

  it('round-trips the /clear marker (cleared_before_message_id, cleared_at) through export+import', async () => {
    const { alice, net } = seedAlice();
    // Anchor a /clear at the second message in #general (m2 id = m1 + 1).
    const ts = '2026-05-26T12:34:56.000Z';
    const m2Id = (
      db
        .prepare(`SELECT MAX(id) AS id FROM messages WHERE network_id = ? AND target = ?`)
        .get(net.id, '#general') as { id: number }
    ).id;
    setClearedState(alice.id, net.id, '#general', m2Id, ts);

    const ned = createUser(`ned_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const buf = await exportToBuffer(alice.id, { includeMessages: true });
    await importFromZipBuffer(ned.id, buf);

    // Find the rekeyed message that corresponds to the source boundary.
    const importedRead = db.prepare('SELECT * FROM buffer_reads WHERE user_id = ?').get(ned.id) as {
      last_read_message_id: number;
      cleared_before_message_id: number | null;
      cleared_at: string | null;
    };
    expect(importedRead.cleared_at).toBe(ts);
    expect(importedRead.cleared_before_message_id).not.toBeNull();
    // The boundary points to a real message row in the imported user's space.
    const msg = db
      .prepare('SELECT id FROM messages WHERE id = ?')
      .get(importedRead.cleared_before_message_id);
    expect(msg).toBeDefined();
  });

  it('preserves the read pointer when the /clear boundary message is missing from the import', async () => {
    // Surgically construct a malformed archive: a buffer_reads row whose
    // cleared_before_message_id references a message id that DOES NOT exist
    // in messages.ndjson. The naive fkRekey path would drop the entire row
    // (and lose last_read_message_id along with it); fkRekeyNullable should
    // keep the row with NULL clear instead.
    const { alice } = seedAlice();
    const buf = await exportToBuffer(alice.id, { includeMessages: true });
    const yauzl = await import('yauzl');
    const { ZipArchive } = await import('archiver');

    const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const out = new Map<string, Buffer>();
        zip.readEntry();
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
        zip.on('error', reject);
      });
    });

    const data = JSON.parse(entries.get('data.json')!.toString('utf8'));
    // Inject a clear marker pointing at id 999999 — guaranteed missing from
    // messages.ndjson (which only carries alice's two seeded messages).
    expect(data.buffer_reads.length).toBe(1);
    const originalLastRead = data.buffer_reads[0].last_read_message_id;
    data.buffer_reads[0].cleared_before_message_id = 999999;
    data.buffer_reads[0].cleared_at = '2026-05-26T12:34:56.000Z';
    entries.set('data.json', Buffer.from(JSON.stringify(data)));

    const archive = new ZipArchive();
    const rebuiltChunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => rebuiltChunks.push(c));
    for (const [name, content] of entries) archive.append(content, { name });
    await archive.finalize();
    const rebuilt = Buffer.concat(rebuiltChunks);

    const olive = createUser(`olive_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await importFromZipBuffer(olive.id, rebuilt);

    // The row must survive — losing it would also strand a valid read pointer.
    const importedRead = db
      .prepare('SELECT * FROM buffer_reads WHERE user_id = ?')
      .get(olive.id) as
      | {
          last_read_message_id: number;
          cleared_before_message_id: number | null;
          cleared_at: string | null;
        }
      | undefined;
    expect(importedRead).toBeDefined();
    // Boundary nulls out (FK target was missing); cleared_at is a stale
    // scalar but the read path masks it via the boundary check, so callers
    // see a clean no-clear state.
    expect(importedRead!.cleared_before_message_id).toBeNull();
    const importedNetworkId = (
      db.prepare('SELECT id FROM networks WHERE user_id = ?').get(olive.id) as { id: number }
    ).id;
    expect(getClearedState(olive.id, importedNetworkId, '#general')).toEqual({
      clearedBeforeId: 0,
      clearedAt: null,
    });
    // The rekeyed read pointer must land on a real message row in olive's
    // imported network (not the original alice id; that would be a leaked
    // foreign id from before rekey).
    expect(importedRead!.last_read_message_id).not.toBe(originalLastRead);
    const msg = db
      .prepare('SELECT id FROM messages WHERE id = ?')
      .get(importedRead!.last_read_message_id);
    expect(msg).toBeDefined();
  });

  it('imports an older archive whose messages omit late-added NOT NULL columns (mirrored #439, notable #470, reply_to_self #993)', async () => {
    // A backup taken before messages.mirrored / messages.notable existed has no
    // such key in messages.ndjson. Both are NOT NULL DEFAULT-ed, but a column
    // default does NOT apply when the importer binds an explicit NULL for a
    // missing key — so without the import-side fallback the insert fails with a
    // NOT NULL constraint and aborts the entire restore.
    const { alice } = seedAlice();
    const buf = await exportToBuffer(alice.id, { includeMessages: true });
    const yauzl = await import('yauzl');
    const { ZipArchive } = await import('archiver');

    const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const out = new Map<string, Buffer>();
        zip.readEntry();
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
        zip.on('error', reject);
      });
    });

    // Strip `mirrored` and `notable` from every messages row to mimic an older archive.
    const msgsKey = [...entries.keys()].find((k) => k.endsWith('messages.ndjson'));
    expect(msgsKey).toBeDefined();
    const stripped = entries
      .get(msgsKey!)!
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        const row = JSON.parse(l);
        delete row.mirrored;
        delete row.notable;
        delete row.reply_msgid;
        delete row.reply_to_self;
        return JSON.stringify(row);
      })
      .join('\n');
    entries.set(msgsKey!, Buffer.from(stripped + '\n'));

    const archive = new ZipArchive();
    const rebuiltChunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => rebuiltChunks.push(c));
    for (const [name, content] of entries) archive.append(content, { name });
    await archive.finalize();
    const rebuilt = Buffer.concat(rebuiltChunks);

    const olive = createUser(
      `olive_mirror_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    );
    await importFromZipBuffer(olive.id, rebuilt);

    // Restore succeeds and the messages land with mirrored defaulted to 0 and
    // notable defaulted to 1 (old history predates the notability model → counts).
    const rows = db
      .prepare(
        'SELECT m.mirrored, m.notable, m.reply_to_self FROM messages m JOIN networks n ON n.id = m.network_id WHERE n.user_id = ?',
      )
      .all(olive.id) as Array<{ mirrored: number; notable: number; reply_to_self: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.mirrored === 0)).toBe(true);
    expect(rows.every((r) => r.notable === 1)).toBe(true);
    expect(rows.every((r) => r.reply_to_self === 0)).toBe(true);
  });

  it('converts a legacy archive (channels + closed_buffers, no buffers table) into registry rows', async () => {
    // A backup taken before the buffers registry: existence lived in messages,
    // autojoin/key in `channels`, hide flags in `closed_buffers`. Simulate one
    // by rewriting a modern export's data.json to the old shape.
    const { alice, net } = seedAlice();
    // A DM with history that the legacy archive marks closed (a tombstone).
    insertMessage({
      networkId: net.id,
      target: 'Mallory',
      time: '2026-05-17T10:05:00Z',
      type: 'message',
      nick: 'Mallory',
      text: 'psst',
      self: false,
    });
    const buf = await exportToBuffer(alice.id, { includeMessages: true });
    const yauzl = await import('yauzl');
    const { ZipArchive } = await import('archiver');

    const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const out = new Map<string, Buffer>();
        zip.readEntry();
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
        zip.on('error', reject);
      });
    });

    const data = JSON.parse(entries.get('data.json')!.toString('utf8'));
    delete data.buffers;
    data.channels = [
      // joined=1 + key, has history → open, autojoin, key carried.
      {
        id: 1,
        network_id: net.id,
        name: '#general',
        joined: 1,
        created_at: '2026-01-01',
        key: 'legacykey',
      },
      // joined=0, no history → an un-surfaced config row ('closed', NULL closed_at).
      { id: 2, network_id: net.id, name: '#dusty', joined: 0, created_at: '2026-01-01', key: null },
    ];
    data.closed_buffers = [
      {
        user_id: alice.id,
        network_id: net.id,
        target: 'mallory',
        closed_at: '2026-05-18T00:00:00Z',
      },
    ];
    entries.set('data.json', Buffer.from(JSON.stringify(data)));

    const archive = new ZipArchive();
    const rebuiltChunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => rebuiltChunks.push(c));
    for (const [name, content] of entries) archive.append(content, { name });
    await archive.finalize();
    const rebuilt = Buffer.concat(rebuiltChunks);

    const pat = createUser(`pat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const result = await importFromZipBuffer(pat.id, rebuilt);
    expect(result.counts.buffers).toBeGreaterThan(0);
    const patNet = (
      db.prepare('SELECT id FROM networks WHERE user_id = ?').get(pat.id) as { id: number }
    ).id;

    const general = buffers.getBuffer(pat.id, patNet, '#general')!;
    expect(general.state).toBe('open');
    expect(general.autojoin).toBe(true);
    expect(general.key).toBe('legacykey');

    const dusty = buffers.getBuffer(pat.id, patNet, '#dusty')!;
    expect(dusty.state).toBe('closed');
    expect(dusty.closedAt).toBeNull(); // never surfaced, not user-closed
    expect(dusty.autojoin).toBe(false); // joined=0 in the archive

    // The closed tombstone wins over the message-derived open row, folded.
    const mallory = buffers.getBuffer(pat.id, patNet, 'MALLORY')!;
    expect(mallory.state).toBe('closed');
    expect(mallory.closedAt).toBe('2026-05-18T00:00:00Z');

    // A history-less channel absent from the legacy tables gets no row at all
    // — legacy existence WAS message history.
    expect(buffers.getBuffer(pat.id, patNet, '#dev')).toBeUndefined();
  });

  it("skips a pre-v19 archive's contacts sections (tables dropped with buffer favorites)", async () => {
    // Backups taken before schema v19 carry `contacts`/`contact_targets`
    // sections; the registry no longer declares them, and import iterates the
    // registry — never the archive's keys — so they must be silently ignored,
    // not fatal. This pins the property the drop relied on.
    const { alice, net } = seedAlice();
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    const yauzl = await import('yauzl');
    const { ZipArchive } = await import('archiver');

    const entries = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        const out = new Map<string, Buffer>();
        zip.readEntry();
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
        zip.on('error', reject);
      });
    });

    const data = JSON.parse(entries.get('data.json')!.toString('utf8'));
    data.contacts = [
      { id: 1, user_id: alice.id, display_name: 'Zoe', notify_online: 1, created_at: '2026-01-01' },
    ];
    data.contact_targets = [{ contact_id: 1, network_id: net.id, nick: 'zoe', is_primary: 1 }];
    entries.set('data.json', Buffer.from(JSON.stringify(data)));

    const archive = new ZipArchive();
    const rebuiltChunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => rebuiltChunks.push(c));
    for (const [name, content] of entries) archive.append(content, { name });
    await archive.finalize();
    const rebuilt = Buffer.concat(rebuiltChunks);

    const quinn = createUser(`quinn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const result = await importFromZipBuffer(quinn.id, rebuilt);
    // The rest of the archive lands normally — including the real
    // favorite_buffers section (seedAlice favorites #general) — while the
    // contacts payload never surfaces: no tables to land in, and no favorite
    // conjured from Zoe's contact row.
    expect(result.counts.networks).toBeGreaterThan(0);
    const quinnFavorites = db
      .prepare(
        `SELECT b.target AS target FROM favorite_buffers f
         JOIN buffers b ON b.id = f.buffer_id WHERE f.user_id = ?`,
      )
      .all(quinn.id) as Array<{ target: string }>;
    expect(quinnFavorites).toEqual([{ target: '#general' }]);
  });

  it('rejects an archive without a manifest', async () => {
    createUser(`eve_${Date.now()}`);
    // A zip with only an unrelated file.
    const { ZipArchive } = await import('archiver');
    const archive = new ZipArchive();
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.append('hello', { name: 'random.txt' });
    await archive.finalize();
    const buf = Buffer.concat(chunks);
    await expect(
      importFromZipBuffer(createUser(`eve2_${Date.now()}`).id, buf),
    ).rejects.toMatchObject({
      code: 'missing_manifest',
    });
  });

  it('rejects an archive with a future format version', async () => {
    const frank = createUser(`frank_${Date.now()}`);
    const { ZipArchive } = await import('archiver');
    const archive = new ZipArchive();
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.append(JSON.stringify({ export_format_version: EXPORT_FORMAT_VERSION + 99 }), {
      name: 'manifest.json',
    });
    archive.append('{}', { name: 'data.json' });
    await archive.finalize();
    const buf = Buffer.concat(chunks);
    await expect(importFromZipBuffer(frank.id, buf)).rejects.toMatchObject({
      code: 'format_too_new',
    });
  });

  it('rejects a non-zip blob', async () => {
    const gabby = createUser(`gabby_${Date.now()}`);
    const buf = Buffer.from('this is not a zip file, just text');
    await expect(importFromZipBuffer(gabby.id, buf)).rejects.toBeInstanceOf(ImportError);
  });
});

// Full equivalence: every exported table populated, exported, imported, and
// then compared row-for-row across the two accounts. Columns that are
// expected to differ (rekeyed FKs, autoincrement PKs, last_seen_at on users)
// are projected out so the comparison fails *only* if the payload diverged.
function uniqueUsername(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Internal helper type to access common properties across all table defs.
type AnyTableDef = {
  mode: string;
  scope: string;
  columns: string[];
  pk?: string;
  fkRekey?: Record<string, string>;
  blobColumns?: string[];
  rowWhere?: string;
};

// Columns re-derived on the target instance rather than round-tripped verbatim,
// so they legitimately differ from the source and must be excluded from the
// payload comparison. `ignored_masks` is the only table re-inserted through a
// service on import (ignoreRulesService.add, for regex/expiry validation — see
// importService), and that path lets the DB stamp `created_at` at import time
// instead of preserving the original. Every other table round-trips created_at
// via the positional insert, so this exclusion is deliberately table-scoped —
// widening it would mask a real regression elsewhere. (Comparing created_at
// here is also what made this test flaky: alice's seed time and bob's import
// time differ whenever the clock ticks a second mid-run.)
// `satisfies` keeps the keys checked against the real table registry — a
// mistyped table name is a compile error rather than a silently-ineffective
// exclusion (which would let the flake back in) — while the `Record<string, …>`
// annotation keeps it indexable by the arbitrary `table` string below.
const VOLATILE_COLUMNS: Record<string, string[]> = {
  ignored_masks: ['created_at'],
} satisfies Partial<Record<keyof typeof EXPORT_TABLES, string[]>>;

// Columns that legitimately differ between the source and target accounts.
// Per-table FK-rekey columns are taken from the registry; PKs of
// autoincrement tables also differ; matched_rule_id can legitimately turn
// to NULL on import if its rule wasn't carried over (it shouldn't here).
function projectionFor(table: string, def: AnyTableDef): string[] {
  const skip = new Set<string>(VOLATILE_COLUMNS[table] ?? []);
  if (def.pk) skip.add(def.pk);
  if (def.fkRekey) for (const col of Object.keys(def.fkRekey)) skip.add(col);
  const blobColumns = def.blobColumns ?? [];
  return def.columns.filter((c) => !skip.has(c) && !blobColumns.includes(c));
}

// Sort rows deterministically using their stable (non-rekeyed) columns so
// the comparison doesn't depend on insertion order or autoincrement ids.
function sortKey(row: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((k) => {
      const v = row[k];
      if (v instanceof Buffer) return v.toString('base64');
      return JSON.stringify(v ?? null);
    })
    .join('|');
}

describe('importFromZipBuffer — end-to-end equivalence', () => {
  // Seeds every table declared as 'export' or 'partial' so the equivalence
  // test exercises the full registry, not a subset.
  function seedComplete(): User {
    const user = createUser(uniqueUsername('alice'));
    const net1 = createNetwork(user.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'alice',
      username: 'alice_u',
      realname: 'Alice Tester',
      server_password: 'svrpw',
      autoconnect: true,
      sasl_account: 'alice',
      sasl_password: 'sp',
      connect_commands: 'JOIN #foo',
    }) as Network;
    const net2 = createNetwork(user.id, {
      name: 'oftc',
      host: 'irc.oftc.net',
      port: 6697,
      tls: true,
      nick: 'alice',
    }) as Network;
    buffers.ensureOpen(user.id, net1.id, '#general', { kind: 'channel', autojoin: true });
    buffers.ensureOpen(user.id, net1.id, '#dev', { kind: 'channel' });
    buffers.ensureOpen(user.id, net2.id, '#support', { kind: 'channel', autojoin: true });

    const m1 = insertMessage({
      networkId: net1.id,
      target: '#general',
      time: '2026-05-17T10:00:00Z',
      type: 'message',
      nick: 'alice',
      text: 'hello',
      self: true,
      userhost: 'alice!a@host',
    });
    const m2 = insertMessage({
      networkId: net1.id,
      target: '#general',
      time: '2026-05-17T10:01:00Z',
      type: 'message',
      nick: 'bob',
      text: 'hi alice',
      self: false,
    });
    insertMessage({
      networkId: net2.id,
      target: '#support',
      time: '2026-05-17T10:02:00Z',
      type: 'action',
      nick: 'alice',
      text: 'waves',
      self: true,
    });

    setUserSetting(user.id, 'appearance.theme.name', 'dark');
    setUserSetting(user.id, 'chat.consolidate.join_part', true);
    const rule = createRule(user.id, { pattern: 'alice', kind: 'plain', case_sensitive: false });
    createRule(user.id, { pattern: 'urgent', kind: 'regex', case_sensitive: true });
    // highlight_rule_networks via direct insert (no helper exposes it cleanly).
    db.prepare('INSERT INTO highlight_rule_networks (rule_id, network_id) VALUES (?, ?)').run(
      rule!.id,
      net1.id,
    );

    setNote({ userId: user.id, networkId: net1.id, nick: 'bob', note: 'in berlin' });
    setNote({ userId: user.id, networkId: net2.id, nick: 'carol', note: 'op of #support' });
    addMask({ userId: user.id, networkId: net1.id, mask: 'spammer!*@*' });
    addMask({ userId: user.id, networkId: net2.id, mask: '*!*@evilhost' });
    pinBuffer(user.id, net1.id, '#general');
    pinBuffer(user.id, net2.id, '#support');
    setNicklistCollapsed(user.id, net1.id, '#dev', true);
    setChannelNotifyAlways(user.id, net1.id, '#general', true);
    upsertDraft(user.id, net1.id, '#dev', 'half-typed thought');
    buffers.ensureOpen(user.id, net1.id, '#oldchan', { kind: 'channel' });
    buffers.close(user.id, net1.id, '#oldchan');
    addBookmark(user.id, m1.id as number);
    addBookmark(user.id, m2.id as number);
    // Reactions (#992): a peer's on our line (to_self, with a userhost), and
    // ours on theirs.
    addReaction({
      messageId: m1.id as number,
      networkId: net1.id,
      nick: 'Bob',
      userhost: 'Bob!b@host',
      value: '👍',
      self: false,
      toSelf: true,
      time: '2026-05-17T10:02:00Z',
    });
    addReaction({
      messageId: m2.id as number,
      networkId: net1.id,
      nick: 'alice',
      value: 'ha, same',
      self: true,
      toSelf: false,
      time: '2026-05-17T10:03:00Z',
    });
    // A tombstone (#1009): taken back, and kept for bouncer history.
    addReaction({
      messageId: m1.id as number,
      networkId: net1.id,
      nick: 'carol',
      value: '🎉',
      self: false,
      toSelf: true,
      time: '2026-05-17T10:04:00Z',
    });
    removeReaction(m1.id as number, 'carol', '🎉', false, '2026-05-17T10:05:00Z');
    // (Left behind by the export — see the tombstone test.)
    setReadState(user.id, net1.id, '#general', m2.id as number);
    writeAwayMarker(user.id, net1.id, {
      awayDatetime: '2026-05-17T11:00:00Z',
      awayMessage: 'brb',
      autoSet: false,
    });
    addInputHistory(user.id, net1.id, '#general', '/whois bob');
    addInputHistory(user.id, net1.id, '#general', '/me waves');

    insertUpload(user.id, {
      provider: 'hoarder',
      url: 'https://example.com/foo.jpg',
      filename: 'foo.jpg',
      mime: 'image/jpeg',
      byte_size: 1234,
      width: 100,
      height: 100,
      thumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]),
    });
    insertUpload(user.id, {
      provider: 'catbox',
      url: 'https://example.com/bar.png',
      filename: 'bar.png',
      mime: 'image/png',
      byte_size: 5678,
      width: 200,
      height: 150,
      thumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]),
    });

    return user;
  }

  function rowsFor(userId: number, table: string, def: AnyTableDef): Record<string, unknown>[] {
    let sql: string;
    switch (def.scope) {
      case 'identity':
        sql = `SELECT * FROM ${table} WHERE id = ?`;
        break;
      case 'user_id':
        sql = `SELECT * FROM ${table} WHERE user_id = ?`;
        break;
      case 'via_network':
        sql = `SELECT * FROM ${table}
               WHERE network_id IN (SELECT id FROM networks WHERE user_id = ?)`;
        break;
      case 'via_rules':
        sql = `SELECT * FROM ${table}
               WHERE rule_id IN (SELECT id FROM highlight_rules WHERE user_id = ?)`;
        break;
      case 'owned_uploaders':
        sql = `SELECT * FROM ${table} WHERE scope = 'user' AND owner_user_id = ?`;
        break;
      default:
        throw new Error(`unknown scope ${def.scope}`);
    }
    // The rows the exporter selects: a table's rowWhere leaves some behind on
    // purpose (reaction tombstones, #1009), so they're no part of equivalence.
    if (def.rowWhere) sql += ` AND (${def.rowWhere})`;
    return db.prepare(sql).all(userId) as Record<string, unknown>[];
  }

  function projectRows(
    rows: Record<string, unknown>[],
    projection: string[],
  ): Record<string, unknown>[] {
    return rows
      .map((row) => {
        const out: Record<string, unknown> = {};
        for (const c of projection) out[c] = row[c];
        return out;
      })
      .toSorted((a, b) => sortKey(a, projection).localeCompare(sortKey(b, projection)));
  }

  // upload_history thumbnails ship as separate zip entries, but on the
  // imported side they end up back in the row. Compare BLOBs by content.
  function blobsFor(userId: number): (string | null)[] {
    const rows = db
      .prepare(`SELECT thumbnail FROM upload_history WHERE user_id = ? ORDER BY id ASC`)
      .all(userId) as Array<{ thumbnail: Buffer | null }>;
    return rows
      .map((r) => (r.thumbnail ? Buffer.from(r.thumbnail).toString('base64') : null))
      .toSorted();
  }

  it('round-trips every exported table with payload-identical content', async () => {
    const alice = seedComplete();
    const bob = createUser(uniqueUsername('bob'));

    const buf = await exportToBuffer(alice.id, { includeMessages: true });
    await importFromZipBuffer(bob.id, buf);

    for (const [table, def] of Object.entries(EXPORT_TABLES)) {
      if (def.mode !== 'export' && def.mode !== 'partial') continue;
      // `users` is identity-only: alice keeps her username on alice's
      // instance, bob keeps his on bob's. We don't expect equivalence here.
      if (table === 'users') continue;

      const anyDef = def as unknown as AnyTableDef;
      let aliceRows = rowsFor(alice.id, table, anyDef);
      let bobRows = rowsFor(bob.id, table, anyDef);

      // Sentinel buffer rows (:system:, :server:<id>) are install-local
      // fixtures, excluded from the archive on export and minted by each
      // install for itself (alice's exist for her networks; bob's imported
      // networks mint theirs on first use) — so equivalence is over the real
      // buffers only.
      if (table === 'buffers') {
        const real = (r: Record<string, unknown>) => !String(r.target).startsWith(':');
        aliceRows = aliceRows.filter(real);
        bobRows = bobRows.filter(real);
      }

      // Count parity first — catches missing inserts before we get into
      // payload comparisons (the payload diff would also catch it, but the
      // count failure points at the table much more directly).
      expect(
        bobRows.length,
        `row count mismatch for ${table}: alice=${aliceRows.length}, bob=${bobRows.length}`,
      ).toBe(aliceRows.length);

      const projection = projectionFor(table, anyDef);
      if (projection.length === 0) continue; // table is pure-FK (e.g. highlight_rule_networks)

      expect(projectRows(bobRows, projection), `payload mismatch for ${table}`).toEqual(
        projectRows(aliceRows, projection),
      );
    }

    // BLOBs aren't in the column projection — verify separately.
    expect(blobsFor(bob.id)).toEqual(blobsFor(alice.id));

    // created_at for ignored_masks is excluded from the payload diff above
    // (VOLATILE_COLUMNS) because import re-stamps it. Assert it's still
    // populated on the imported side rather than dropped/null.
    const bobMaskTimes = db
      .prepare('SELECT created_at FROM ignored_masks WHERE user_id = ?')
      .all(bob.id) as Array<{ created_at: string | null }>;
    expect(bobMaskTimes.length).toBeGreaterThan(0);
    expect(bobMaskTimes.every((r) => !!r.created_at)).toBe(true);

    // Structural FK sanity: every per-network row in bob's tables must
    // point at one of bob's networks, not alice's.
    const bobNetIds = new Set(
      (
        db.prepare('SELECT id FROM networks WHERE user_id = ?').all(bob.id) as Array<{ id: number }>
      ).map((r) => r.id),
    );
    void bobNetIds; // used for documentation; sanity check is done via SQL below
    const tablesWithNetworkFk = Object.entries(EXPORT_TABLES)
      .filter(
        ([, d]) =>
          'fkRekey' in d &&
          d.fkRekey &&
          Object.values(d.fkRekey as Record<string, string>).includes('networks'),
      )
      .map(([t]) => t);
    const tablesWithNetworkFkAndUserId = tablesWithNetworkFk.filter((t) => {
      const tDef = EXPORT_TABLES[t as keyof typeof EXPORT_TABLES] as unknown as AnyTableDef;
      return tDef.scope === 'user_id';
    });
    for (const t of tablesWithNetworkFkAndUserId) {
      const strayForBob = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${t}
                  WHERE user_id = ?
                    AND network_id NOT IN (SELECT id FROM networks WHERE user_id = ?)`,
          )
          .get(bob.id, bob.id) as { n: number }
      ).n;
      expect(strayForBob, `${t} has bob rows referencing non-bob networks`).toBe(0);
    }

    // Rule-network junction (no user_id column) — verify via_rules scope.
    const junctionStray = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM highlight_rule_networks
                WHERE rule_id IN (SELECT id FROM highlight_rules WHERE user_id = ?)
                  AND network_id NOT IN (SELECT id FROM networks WHERE user_id = ?)`,
        )
        .get(bob.id, bob.id) as { n: number }
    ).n;
    expect(junctionStray).toBe(0);
  });
});

// A user's own configured uploaders (#514). They became exportable when the
// legacy uploads.* settings keys — which used to carry this across an export —
// were deleted, so without this they'd vanish from a user's data export entirely.
describe('uploader_config — export/import', () => {
  it('carries a personal uploader across, WITHOUT its secret', async () => {
    const alice = createUser(`up_alice_${Date.now()}`);
    const bob = createUser(`up_bob_${Date.now()}`);
    const { createUploaderConfig } = await import('../db/uploaderConfig.js');
    const { setUserSetting, getUserSettings } = await import('../db/settings.js');

    const mine = createUploaderConfig({
      scope: 'user',
      ownerUserId: alice.id,
      driver: 'zipline',
      label: 'My Zipline',
      values: { url: 'https://zip.example', token: 'TOP-SECRET-TOKEN' },
    });
    setUserSetting(alice.id, 'uploads.uploader_id', mine);

    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    // The secret must not be anywhere in the archive: on a keyless self-host the
    // at-rest envelope is a plaintext passthrough, so a naive export would put the
    // token in the clear inside a zip the user hands around.
    expect(buf.toString('binary')).not.toContain('TOP-SECRET-TOKEN');

    await importFromZipBuffer(bob.id, buf);

    const bobRows = db
      .prepare(`SELECT * FROM uploader_config WHERE scope = 'user' AND owner_user_id = ?`)
      .all(bob.id) as Array<{
      id: number;
      driver: string;
      label: string;
      config_json: string;
      secrets_enc: string | null;
      is_default: number;
      offered_to_users: number;
      locked: number;
    }>;
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0].driver).toBe('zipline');
    expect(bobRows[0].label).toBe('My Zipline');
    expect(JSON.parse(bobRows[0].config_json).url).toBe('https://zip.example');
    // Arrives credential-less by design — Bob re-enters the token.
    expect(bobRows[0].secrets_enc).toBeNull();
    // An imported row can never smuggle itself in as an offered instance default.
    expect(bobRows[0].is_default).toBe(0);
    expect(bobRows[0].offered_to_users).toBe(0);
    expect(bobRows[0].locked).toBe(0);

    // The selection pointer is an id living inside a user_settings VALUE — the one
    // id in the archive the column-based rekey machinery can't see. It must be
    // rewritten to Bob's new row, not left pointing at Alice's.
    expect(getUserSettings(bob.id)['uploads.uploader_id']).toBe(bobRows[0].id);
    expect(getUserSettings(bob.id)['uploads.uploader_id']).not.toBe(mine);
  });

  it('does not export the INSTANCE uploaders, and drops a pointer at one', async () => {
    const alice = createUser(`up_inst_alice_${Date.now()}`);
    const bob = createUser(`up_inst_bob_${Date.now()}`);
    const { listInstanceUploaders } = await import('../db/uploaderConfig.js');
    const { setUserSetting, getUserSettings } = await import('../db/settings.js');

    const x0 = listInstanceUploaders().find((r) => r.driver === 'x0')!;
    setUserSetting(alice.id, 'uploads.uploader_id', x0.id);

    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    await importFromZipBuffer(bob.id, buf);

    // The operator's rows are not Alice's data and must not ride along.
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM uploader_config WHERE scope = 'user' AND owner_user_id = ?`,
        )
        .get(bob.id),
    ).toEqual({ n: 0 });
    // An instance id means nothing on the target, so the pointer is dropped and
    // Bob lands on the target's own default rather than a dangling id.
    expect(getUserSettings(bob.id)['uploads.uploader_id']).toBeUndefined();
  });
});

describe('user_themes — export/import', () => {
  it('round-trips saved themes and rewrites the look.theme.* pointers through the id map', async () => {
    const themesService = (await import('./themesService.js')).default;
    const settingsService = (await import('./settingsService.js')).default;
    const { getUserSettings } = await import('../db/settings.js');
    const { alice } = seedAlice();
    const created = themesService.create(alice.id, {
      name: 'Ocean',
      values: { 'look.color.bg': '#101010', 'look.color.fg': '#f0f0f0' },
    });
    if (!created.ok) throw new Error(created.error);
    settingsService.update(alice.id, {
      'look.theme.active': String(created.theme.id),
      // Built-in ids travel as-is; non-default so the row persists.
      'look.theme.light': 'dark',
    });

    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    const bob = createUser(`bob_themes_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await importFromZipBuffer(bob.id, buf);

    const imported = themesService.list(bob.id).find((t) => t.name === 'Ocean');
    expect(imported).toBeDefined();
    expect(imported!.values).toEqual({ 'look.color.bg': '#101010', 'look.color.fg': '#f0f0f0' });
    // The pointer follows the theme's NEW id on the target; built-ins pass through.
    expect(getUserSettings(bob.id)['look.theme.active']).toBe(String(imported!.id));
    expect(getUserSettings(bob.id)['look.theme.light']).toBe('dark');
  });

  it("replaces a zero-network account's pre-existing themes instead of colliding on the name", async () => {
    const themesService = (await import('./themesService.js')).default;
    const { alice } = seedAlice();
    const created = themesService.create(alice.id, {
      name: 'Ocean',
      values: { 'look.color.bg': '#101010' },
    });
    if (!created.ok) throw new Error(created.error);
    const buf = await exportToBuffer(alice.id, { includeMessages: false });

    // accountIsEmpty checks networks only, so a fresh account can still hold a
    // saved theme — with a case-twin name that would abort the whole import on
    // the NOCASE UNIQUE constraint if the import merged instead of replacing.
    const bob = createUser(`bob_twin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const twin = themesService.create(bob.id, {
      name: 'ocean',
      values: { 'look.color.bg': '#eeeeee' },
    });
    if (!twin.ok) throw new Error(twin.error);

    await importFromZipBuffer(bob.id, buf);
    const names = themesService.list(bob.id).map((t) => t.name);
    expect(names).toEqual(['Ocean']);
    expect(themesService.list(bob.id)[0].values['look.color.bg']).toBe('#101010');
  });
});

// Uploaded avatar sets (#607): the rows travel in data.json, the tiles as
// avatar_sets/<id>/<nnn>.webp entries, and the look.avatars.set pointer
// rewrites through the id map like a theme pointer.
describe('importFromZipBuffer — avatar sets', () => {
  it('round-trips a set with its tiles and the pointer at it', async () => {
    const { alice } = seedAlice();
    const avatarSets = (await import('./avatarSetsService.js')).default;
    const square = (color: string) =>
      sharp({ create: { width: 16, height: 16, channels: 4, background: color } })
        .png()
        .toBuffer();
    const made = await avatarSets.createFromImages(alice.id, 'Blocks', [
      { name: 'a.png', data: await square('#ff0000') },
      { name: 'b.png', data: await square('#00ff00') },
      { name: 'c.png', data: await square('#0000ff') },
      { name: 'd.png', data: await square('#ffffff') },
    ]);
    expect(made.ok).toBe(true);
    const setId = made.ok ? made.set.id : 0;
    setUserSetting(alice.id, 'look.avatars.set', String(setId));

    const bob = createUser(`bob_avatars_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const buf = await exportToBuffer(alice.id, { includeMessages: false });
    const names = [...(await unzipToMap(buf)).keys()].filter((n) => n.startsWith('avatar_sets/'));
    expect(names).toEqual([0, 1, 2, 3].map((i) => `avatar_sets/${setId}/00${i}.webp`));

    await importFromZipBuffer(bob.id, buf);
    const bobSets = avatarSets.list(bob.id);
    expect(bobSets).toHaveLength(1);
    expect(bobSets[0]).toMatchObject({ name: 'Blocks', count: 4 });
    expect(bobSets[0].id).not.toBe(setId);
    // Same bytes, tile for tile (the normaliser is deterministic on its own output).
    for (let i = 0; i < 4; i++) {
      const a = avatarSets.tile(alice.id, setId, i)!;
      const b = avatarSets.tile(bob.id, bobSets[0].id, i)!;
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    }
    const pointer = db
      .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(bob.id, 'look.avatars.set') as { value: string };
    expect(JSON.parse(pointer.value)).toBe(String(bobSets[0].id));
  });

  // An archive from before schema v28: it names settings and choices by what
  // they were called then, and lands as the migration would have left the
  // install it came from.
  it('moves settings and themes from an older archive to their current names', async () => {
    const themesService = (await import('./themesService.js')).default;
    const { alice } = seedAlice();
    setUserSetting(alice.id, 'look.message.layout', 'standard');
    setUserSetting(alice.id, 'look.avatars.set', 'plain-dark');
    setUserSetting(alice.id, 'look.message.compact.indent', 3);
    setUserSetting(alice.id, 'look.buffer.time_format_compact', 'HH:mm:ss');
    // As a v27 install stored it: the service would refuse the old key today.
    db.prepare(`INSERT INTO user_themes (user_id, name, values_json) VALUES (?, ?, ?)`).run(
      alice.id,
      'Tight',
      JSON.stringify({ 'look.color.bg': '#101010', 'look.message.compact.group_gap': 4 }),
    );
    const carol = createUser(`carol_old_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    setUserSetting(carol.id, 'look.message.layout', 'compact');
    setUserSetting(carol.id, 'look.avatars.set', 'initial-light');

    const read = (userId: number, key: string) => {
      const row = db
        .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
        .get(userId, key) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : undefined;
    };
    const into = async (fromId: number) => {
      const to = createUser(`old_into_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      await importFromZipBuffer(to.id, await exportToBuffer(fromId, { includeMessages: false }));
      return to.id;
    };

    const fromAlice = await into(alice.id);
    expect(read(fromAlice, 'look.message.layout')).toBeUndefined();
    expect(read(fromAlice, 'look.avatars.set')).toBe('plain');
    expect(read(fromAlice, 'look.message.modern.indent')).toBe(3);
    expect(read(fromAlice, 'look.buffer.time_format_modern')).toBe('HH:mm:ss');
    expect(read(fromAlice, 'look.message.compact.indent')).toBeUndefined();
    expect(read(fromAlice, 'look.buffer.time_format_compact')).toBeUndefined();
    expect(themesService.list(fromAlice).find((t) => t.name === 'Tight')?.values).toEqual({
      'look.color.bg': '#101010',
      'look.message.modern.group_gap': 4,
    });

    const fromCarol = await into(carol.id);
    expect(read(fromCarol, 'look.message.layout')).toBe('modern');
    expect(read(fromCarol, 'look.avatars.set')).toBe('initial');
  });

  it('keeps a current archive as it is', async () => {
    const { alice } = seedAlice();
    setUserSetting(alice.id, 'look.message.layout', 'modern');
    setUserSetting(alice.id, 'look.message.modern.indent', 2);
    const to = createUser(`now_into_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    await importFromZipBuffer(to.id, await exportToBuffer(alice.id, { includeMessages: false }));
    const rows = db
      .prepare(
        `SELECT key, value FROM user_settings WHERE user_id = ? AND key LIKE 'look.message.%'`,
      )
      .all(to.id) as Array<{ key: string; value: string }>;
    expect(Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))).toEqual({
      'look.message.layout': 'modern',
      'look.message.modern.indent': 2,
    });
  });
});

// ---- archive bounds (zip bomb) ----
// Each limit is injected small so the test archive stays small too; the point
// is that every whole-entry read, and the one streamed read, has a bound at all.
describe('import archive bounds', () => {
  const limits = {
    manifestBytes: 256,
    jsonBytes: 4096,
    thumbnailBytes: 64,
    thumbnailsTotalBytes: 128,
    ndjsonLineBytes: 512,
    entries: 8,
  };

  async function archive(extra: Record<string, Buffer>): Promise<Buffer> {
    const entries = new Map<string, Buffer>();
    entries.set(
      'manifest.json',
      Buffer.from(JSON.stringify({ export_format_version: 1, lurker_version: 'test' })),
    );
    entries.set('data.json', Buffer.from(JSON.stringify({ networks: [] })));
    for (const [name, buf] of Object.entries(extra)) entries.set(name, buf);
    return zipFromMap(entries);
  }

  // The thrown ImportError, so each test asserts its code where lint can see it.
  async function rejection(user: User, buf: Buffer): Promise<{ code: string }> {
    const err = await importFromZipBuffer(user.id, buf, limits).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    return err as InstanceType<typeof ImportError>;
  }

  it('refuses a manifest past its bound', async () => {
    const user = createUser(`bounds_m_${Date.now()}`);
    const padded = JSON.stringify({ export_format_version: 1, pad: 'x'.repeat(400) });
    expect(
      (await rejection(user, await archive({ 'manifest.json': Buffer.from(padded) }))).code,
    ).toBe('entry_too_large');
  });

  it('refuses data.json past its bound', async () => {
    const user = createUser(`bounds_d_${Date.now()}`);
    const padded = JSON.stringify({ networks: [], pad: 'x'.repeat(8192) });
    expect((await rejection(user, await archive({ 'data.json': Buffer.from(padded) }))).code).toBe(
      'entry_too_large',
    );
  });

  it('refuses a section file past its bound', async () => {
    const user = createUser(`bounds_s_${Date.now()}`);
    const padded = JSON.stringify([{ pad: 'x'.repeat(8192) }]);
    expect(
      (await rejection(user, await archive({ 'bookmarks.json': Buffer.from(padded) }))).code,
    ).toBe('entry_too_large');
  });

  it('refuses a messages.ndjson line past its bound', async () => {
    const user = createUser(`bounds_n_${Date.now()}`);
    const line = JSON.stringify({ id: 1, text: 'x'.repeat(2048) });
    expect(
      (await rejection(user, await archive({ 'messages.ndjson': Buffer.from(`${line}\n`) }))).code,
    ).toBe('entry_too_large');
  });

  it('refuses an archive with too many entries', async () => {
    const user = createUser(`bounds_e_${Date.now()}`);
    const extra: Record<string, Buffer> = {};
    for (let i = 0; i < 20; i++) extra[`thumbnails/${i}.webp`] = Buffer.from('x');
    expect((await rejection(user, await archive(extra))).code).toBe('too_many_entries');
  });

  it('accepts CR-separated messages.ndjson rows like readline does', async () => {
    const user = createUser(`bounds_cr_${Date.now()}`);
    // Five short rows: as one LF-less run they would be 45 bytes against a
    // 12-byte line bound; as the five lines readline sees, each is 8.
    const buf = await archive({ 'messages.ndjson': Buffer.from('{"id":1}\r'.repeat(5)) });
    const result = await importFromZipBuffer(user.id, buf, { ...limits, ndjsonLineBytes: 12 });
    // Rows with no network to map to are dropped; the point is no throw.
    expect(result.counts.messages).toBe(0);
  });

  it('skips a thumbnail past its own bound or the total budget, and keeps the rest', async () => {
    // Real upload rows, so the surviving thumbnails are observable on them.
    const { alice } = seedAlice(); // one upload already
    for (let i = 0; i < 4; i++) {
      insertUpload(alice.id, {
        provider: 'hoarder',
        url: `https://example.com/t${i}.jpg`,
        filename: `t${i}.jpg`,
        mime: 'image/jpeg',
        byte_size: 10,
        width: 10,
        height: 10,
        thumbnail: Buffer.from([0xff, 0xd8, 0xff, 0xe0, i]),
      });
    }
    const exported = await unzipToMap(await exportToBuffer(alice.id, { includeMessages: false }));
    const thumbNames = [...exported.keys()]
      .filter((n) => /^thumbnails\/\d+\.jpg$/.test(n))
      .sort((a, b) => parseInt(a.slice(11), 10) - parseInt(b.slice(11), 10));
    expect(thumbNames.length).toBe(5);
    // Per-thumbnail bound 64, total 100, in central-directory order:
    // 40 kept (40), 200 over its own bound, 40 kept (80), 40 would overrun the
    // total, 10 kept (90).
    const sizes = [40, 200, 40, 40, 10];
    const rebuilt = new Map<string, Buffer>();
    for (const [name, buf] of exported) if (!name.startsWith('thumbnails/')) rebuilt.set(name, buf);
    thumbNames.forEach((name, i) => rebuilt.set(name, Buffer.alloc(sizes[i], i + 1)));

    const bob = createUser(`bounds_tb_${Date.now()}`);
    const result = await importFromZipBuffer(bob.id, await zipFromMap(rebuilt), {
      ...limits,
      manifestBytes: 64 * 1024,
      jsonBytes: 1024 * 1024,
      entries: 1000,
      thumbnailBytes: 64,
      thumbnailsTotalBytes: 100,
    });
    expect(result.thumbnailsAttached).toBe(3);
    const rows = db
      .prepare('SELECT thumbnail FROM upload_history WHERE user_id = ? ORDER BY id')
      .all(bob.id) as Array<{ thumbnail: Buffer | null }>;
    expect(rows.map((r) => (r.thumbnail ? Buffer.from(r.thumbnail).length : null))).toEqual([
      40,
      null,
      40,
      null,
      10,
    ]);
  });

  it('a corrupt messages.ndjson entry fails the import instead of the process', async () => {
    const user = createUser(`bounds_c_${Date.now()}`);
    const line = JSON.stringify({ id: 1, text: 'hello '.repeat(40) });
    const buf = await archive({ 'messages.ndjson': Buffer.from(`${line}\n`.repeat(20)) });
    // Flip bytes inside the DEFLATE stream of that entry: its local header
    // (PK\x03\x04 + name) is followed by the compressed bytes.
    const at = buf.indexOf('messages.ndjson') + 'messages.ndjson'.length + 8;
    for (let k = 0; k < 8; k++) buf[at + k] ^= 0xff;
    let uncaught: unknown = null;
    const trap = (err: unknown) => {
      uncaught = err;
    };
    process.prependOnceListener('uncaughtException', trap);
    try {
      const err = await importFromZipBuffer(user.id, buf, limits).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportError);
      expect((err as InstanceType<typeof ImportError>).code).toBe('insert_failed');
    } finally {
      process.removeListener('uncaughtException', trap);
    }
    expect(uncaught).toBeNull();
  });

  it('checks the account is empty before reading any entry body', async () => {
    const { alice } = seedAlice();
    const padded = JSON.stringify({ export_format_version: 1, pad: 'x'.repeat(400) });
    expect(
      (await rejection(alice, await archive({ 'manifest.json': Buffer.from(padded) }))).code,
    ).toBe('account_not_empty');
  });
});
