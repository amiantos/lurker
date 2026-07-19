// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Integration test for the schemaVersion-16 cutover: a DB shaped like a real
// v15 install (legacy channels + closed_buffers tables, buffer existence
// derived from messages) is built RAW before db/index.ts is ever imported;
// importing it then runs migrate() + the v16 backfill against that data. The
// fixture tables use the pristine pre-registry DDL (migrate()'s CREATE IF NOT
// EXISTS leaves them untouched), and app_meta pins schema_version=15 so only
// the v16 block runs.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-bufmig-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let buffers: typeof import('./buffers.js');

beforeAll(async () => {
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE networks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 6697,
      tls INTEGER NOT NULL DEFAULT 1,
      trusted_certificates INTEGER NOT NULL DEFAULT 1,
      nick TEXT NOT NULL,
      username TEXT,
      realname TEXT,
      server_password TEXT,
      autoconnect INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      joined INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      key TEXT,
      UNIQUE (network_id, name),
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      time TEXT NOT NULL,
      type TEXT NOT NULL,
      nick TEXT,
      text TEXT,
      kind TEXT,
      self INTEGER NOT NULL DEFAULT 0,
      extra TEXT,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE TABLE closed_buffers (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target)
    );
    CREATE TABLE buffer_reads (
      user_id INTEGER NOT NULL,
      network_id INTEGER,
      target TEXT NOT NULL,
      last_read_message_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      cleared_before_message_id INTEGER,
      cleared_at TEXT,
      PRIMARY KEY (user_id, network_id, target)
    );
    CREATE TABLE app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO app_meta (key, value) VALUES ('schema_version', '15');

    INSERT INTO users (id, username) VALUES (1, 'mig-alice'), (2, 'mig-bob');
    INSERT INTO networks (id, user_id, name, host, nick)
      VALUES (10, 1, 'libera', 'irc.libera.chat', 'alice'),
             (20, 2, 'oftc', 'irc.oftc.net', 'bob');

    -- alice, net 10:
    --   #Chatty: history under two casings (majority '#Chatty'), joined=1 keyed
    --   #parted: history, joined=0
    --   #Config: channels row only, joined=1, no history (config-seeded)
    --   Bob: DM history
    --   Ghost: DM history + closed
    --   #tomb:  closed_buffers tombstone with no history at all
    INSERT INTO messages (network_id, target, time, type, nick, text) VALUES
      (10, '#Chatty', '2026-01-01T00:00:00Z', 'message', 'x', 'a'),
      (10, '#Chatty', '2026-01-01T00:01:00Z', 'message', 'x', 'b'),
      (10, '#chatty', '2026-01-01T00:02:00Z', 'message', 'x', 'stray case'),
      (10, '#parted', '2026-01-01T00:03:00Z', 'message', 'x', 'c'),
      (10, 'Bob', '2026-01-01T00:04:00Z', 'message', 'Bob', 'hi'),
      (10, 'Ghost', '2026-01-01T00:05:00Z', 'message', 'Ghost', 'boo'),
      (10, ':server:10', '2026-01-01T00:06:00Z', 'notice', NULL, 'motd'),
      (20, '#other', '2026-01-01T00:07:00Z', 'message', 'y', 'd');
    INSERT INTO channels (network_id, name, joined, key) VALUES
      (10, '#chatty', 1, 'sekrit'),
      (10, '#parted', 0, NULL),
      (10, '#Config', 1, NULL);
    INSERT INTO closed_buffers (user_id, network_id, target, closed_at) VALUES
      (1, 10, 'ghost', '2026-02-01T00:00:00Z'),
      (1, 10, '#tomb', '2026-02-02T00:00:00Z');
    -- Read pointer stranded on the STRAY casing of the #Chatty fork. The read
    -- paths key buffer_reads by exact target, so without the v16 fold this row
    -- would detach from the canonicalized registry row and every snapshot
    -- would count the buffer's whole history as unread.
    INSERT INTO buffer_reads (user_id, network_id, target, last_read_message_id)
      VALUES (1, 10, '#chatty', 2);
  `);
  raw.close();

  // First import runs migrate() + the v16 cutover against the fixture.
  await import('./index.js');
  buffers = await import('./buffers.js');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('schemaVersion 16 — buffers backfill', () => {
  it('drops the legacy tables and bumps the version', async () => {
    const db = (await import('./index.js')).default;
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('buffers');
    expect(tables).not.toContain('channels');
    expect(tables).not.toContain('closed_buffers');
    const v = db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(Number(v.value)).toBeGreaterThanOrEqual(16);
  });

  it('folds the satellites onto the same canonical casing (read pointers stay attached)', async () => {
    const db = (await import('./index.js')).default;
    // The fold merged the messages fork onto '#Chatty'…
    const msgTargets = db
      .prepare(
        `SELECT DISTINCT target FROM messages WHERE network_id = 10 AND lower(target) = '#chatty'`,
      )
      .all() as Array<{ target: string }>;
    expect(msgTargets.map((r) => r.target)).toEqual(['#Chatty']);
    // …and moved the stray-cased read pointer with it, so the exact-target
    // read-state lookup still resolves against the registry's canonical name.
    const reads = db
      .prepare(`SELECT target, last_read_message_id AS lr FROM buffer_reads WHERE network_id = 10`)
      .all() as Array<{ target: string; lr: number }>;
    expect(reads).toEqual([{ target: '#Chatty', lr: 2 }]);
  });

  it('merges a case-forked channel onto the message-majority casing, carrying autojoin + key', () => {
    const row = buffers.getBuffer(1, 10, '#chatty')!;
    expect(row.target).toBe('#Chatty'); // majority casing, not the channels row's
    expect(row.kind).toBe('channel');
    expect(row.state).toBe('open');
    expect(row.autojoin).toBe(true);
    expect(row.key).toBe('sekrit');
    // Exactly one row survived the fold.
    const variants = buffers
      .listForNetwork(10)
      .filter((b) => buffers.foldTarget(b.target) === '#chatty');
    expect(variants).toHaveLength(1);
  });

  it('keeps a parted channel with history open and un-autojoined', () => {
    const row = buffers.getBuffer(1, 10, '#parted')!;
    expect(row.state).toBe('open');
    expect(row.autojoin).toBe(false);
  });

  it('backfills a config-seeded history-less channel as never-surfaced', () => {
    const row = buffers.getBuffer(1, 10, '#config')!;
    expect(row.state).toBe('closed');
    expect(row.closedAt).toBeNull(); // never surfaced ≠ user-closed
    expect(row.autojoin).toBe(true); // still rejoins; the echo will surface it
  });

  it('backfills DMs: open with history, closed when a tombstone matches (folded)', () => {
    expect(buffers.getBuffer(1, 10, 'bob')!.state).toBe('open');
    expect(buffers.getBuffer(1, 10, 'bob')!.kind).toBe('dm');
    const ghost = buffers.getBuffer(1, 10, 'GHOST')!;
    expect(ghost.state).toBe('closed');
    expect(ghost.closedAt).toBe('2026-02-01T00:00:00Z');
  });

  it('imports a history-less closed tombstone as a closed row (NOTICE still cannot resurrect it)', () => {
    const tomb = buffers.getBuffer(1, 10, '#tomb')!;
    expect(tomb.state).toBe('closed');
    expect(tomb.closedAt).toBe('2026-02-02T00:00:00Z');
  });

  it('never creates rows for :server: virtual targets', () => {
    expect(buffers.getBuffer(1, 10, ':server:10')).toBeUndefined();
  });

  it('scopes rows to each network owner', () => {
    const other = buffers.getBuffer(2, 20, '#other')!;
    expect(other.userId).toBe(2);
    expect(buffers.getBuffer(1, 20, '#other')).toBeUndefined();
    expect(buffers.listForUser(1).every((b) => b.networkId === 10)).toBe(true);
  });
});
