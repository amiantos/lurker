// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// ensureMessagesFts: a database carrying the index in its first shape (text
// alone, the v3 triggers) is rebuilt at boot to the scoped shape (#1302), in
// resumable chunks, and a database already there is left untouched.
//
// The fixture is a REAL schema with only the index downgraded: boot once,
// swap the four objects for their v3 text over existing rows, boot again.

import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-fts-shape-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// What v3 and the old update-trigger reconcile left on every deployed database.
const V3 = `
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text,
    content='messages',
    content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE ON messages
  WHEN old.text IS NOT new.text OR old.id IS NOT new.id BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
`;

describe('ensureMessagesFts', () => {
  it('rebuilds a v3 index to the scoped shape, once', async () => {
    // Boot 1: the real schema, with rows on two users' networks.
    let mod = await import('./index.js');
    const users = await import('./users.js');
    const networks = await import('./networks.js');
    let messages = await import('./messages.js');
    const mine = users.createUser('shape-mine');
    const theirs = users.createUser('shape-theirs');
    const myNet = networks.createNetwork(mine.id, { name: 'a', host: 'h', nick: 'me' })!;
    const theirNet = networks.createNetwork(theirs.id, { name: 'b', host: 'h', nick: 'them' })!;
    const add = (networkId: number, target: string, text: string) =>
      Number(
        messages.insertMessage({
          networkId,
          target,
          time: new Date().toISOString(),
          type: 'message',
          nick: 'alice',
          text,
        }).id,
      );
    const a = add(myNet.id, '#one', 'turbot here');
    const b = add(myNet.id, '#two', 'turbot there');
    add(theirNet.id, '#one', 'turbot elsewhere');
    mod.default.close();

    // Downgrade only the index.
    const raw = new Database(dbPath);
    raw.exec(`DROP TRIGGER messages_ai; DROP TRIGGER messages_ad; DROP TRIGGER messages_au;
              DROP TABLE messages_fts;`);
    raw.exec(V3);
    raw.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
    // The fixture is the old shape: a scoped MATCH cannot even be asked.
    expect(() =>
      raw
        .prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`)
        .all('buffer:("buf1")'),
    ).toThrow(/no such column/);
    raw.close();

    // Boot 2: the rebuild.
    vi.resetModules();
    mod = await import('./index.js');
    messages = await import('./messages.js');
    const db = mod.default;
    const sqlOf = (name: string) =>
      (
        db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name) as
          | { sql: string }
          | undefined
      )?.sql;
    const fillCursor = () =>
      (
        db.prepare(`SELECT value FROM app_meta WHERE key = 'messages_fts_fill'`).get() as
          | { value: string }
          | undefined
      )?.value;
    const integrity = () =>
      db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`);
    expect(sqlOf('messages_fts')).toMatch(
      /fts5\(text, buffer, network, content='messages_fts_src'/,
    );
    for (const trigger of ['messages_ai', 'messages_ad', 'messages_au']) {
      expect(sqlOf(trigger)).toMatch(/'buf' \|\| \w+\.buffer_id, 'net' \|\| \w+\.network_id/);
    }
    expect(fillCursor()).toBeUndefined();
    integrity();

    // The rows that were there before the rebuild are found, by scope.
    const ids = (opts: Parameters<typeof messages.searchMessages>[1]) =>
      messages
        .searchMessages(mine.id, opts)
        .map((m) => m.id)
        .sort((x, y) => x - y);
    expect(ids({ query: 'turbot' })).toEqual([a, b]);
    expect(ids({ query: 'turbot', target: '#one' })).toEqual([a]);
    expect(ids({ query: 'turbot', networkId: theirNet.id })).toEqual([]);
    // New rows go through the new triggers.
    const c = add(myNet.id, '#one', 'turbot again');
    expect(ids({ query: 'turbot', target: '#one' })).toEqual([a, c]);

    // Already current: nothing is written (schema_version counts every
    // schema change this connection has seen committed).
    const before = db.pragma('schema_version', { simple: true });
    expect(mod.ensureMessagesFts('drop')).toBe(false);
    expect(mod.ensureMessagesFts()).toBe(false);
    expect(db.pragma('schema_version', { simple: true })).toBe(before);

    // One trigger gone is a stale shape too: the index can no longer be
    // trusted, so the early half drops all of it and the late half rebuilds —
    // here two rows to a chunk, so the fill takes several commits.
    for (let i = 0; i < 7; i++) add(myNet.id, '#two', `filler ${i}`);
    db.exec(`DROP TRIGGER messages_ad`);
    expect(mod.ensureMessagesFts('drop')).toBe(true);
    expect(sqlOf('messages_fts')).toBeUndefined();
    expect(sqlOf('messages_ai')).toBeUndefined();
    expect(mod.ensureMessagesFts('build', 2)).toBe(true);
    expect(sqlOf('messages_ad')).toMatch(/'delete', old\.id, old\.text, 'buf' \|\| old\.buffer_id/);
    expect(fillCursor()).toBeUndefined();
    expect(ids({ query: 'turbot' })).toEqual([a, b, c]);
    expect(ids({ query: 'filler' })).toHaveLength(7);
    integrity();
  });

  it('resumes a fill that was killed part-way', async () => {
    const mod = await import('./index.js');
    const messages = await import('./messages.js');
    const db = mod.default;
    const all = (db.prepare(`SELECT id FROM messages ORDER BY id`).all() as { id: number }[]).map(
      (r) => r.id,
    );
    expect(all.length).toBeGreaterThan(6);
    // What the INDEX holds (a plain SELECT would read the content view): every
    // row carries a network term.
    const indexed = () =>
      (
        db
          .prepare(
            `SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'network:net*' ORDER BY rowid`,
          )
          .all() as { rowid: number }[]
      ).map((r) => r.rowid);

    // What a kill after the second chunk leaves: table and view, no
    // triggers, the first rows indexed, the cursor on the last of them.
    const half = all.slice(0, 4);
    db.exec(`DROP TRIGGER messages_ai; DROP TRIGGER messages_ad; DROP TRIGGER messages_au;`);
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('delete-all')`);
    db.prepare(
      `INSERT INTO messages_fts(rowid, text, buffer, network)
       SELECT id, text, buffer, network FROM messages_fts_src WHERE id <= ?`,
    ).run(half[3]);
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('messages_fts_fill', ?)`).run(
      String(half[3]),
    );

    // The early half leaves a fill in progress alone...
    expect(mod.ensureMessagesFts('drop')).toBe(true);
    expect(indexed()).toEqual(half);
    // ...and the late half indexes the rest, each row once.
    expect(mod.ensureMessagesFts('build', 2)).toBe(true);
    expect(indexed()).toEqual(all);
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`);
    const user = (
      db.prepare(`SELECT id FROM users WHERE username = 'shape-mine'`).get() as {
        id: number;
      }
    ).id;
    expect(messages.searchMessages(user, { query: 'filler' })).toHaveLength(7);
    expect(mod.ensureMessagesFts()).toBe(false);
  });
});
