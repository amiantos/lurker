// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// ensureMessagesFts: a database carrying the index in its first shape (text
// alone, the v3 triggers) is rebuilt at boot to the scoped shape (#1302), and
// a database already there is left untouched.
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
        .all('buffer_id:("1")'),
    ).toThrow(/no such column/);
    raw.close();

    // Boot 2: the rebuild.
    vi.resetModules();
    mod = await import('./index.js');
    messages = await import('./messages.js');
    const db = mod.default;
    const sqlOf = (name: string) =>
      (db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name) as { sql: string }).sql;
    expect(sqlOf('messages_fts')).toMatch(/fts5\(text, buffer_id, network_id, content='messages'/);
    for (const trigger of ['messages_ai', 'messages_ad', 'messages_au']) {
      expect(sqlOf(trigger)).toMatch(/buffer_id, network_id/);
    }
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`);

    // The rows that were there before the rebuild are found, by scope.
    const ids = (opts: Parameters<typeof messages.searchMessages>[1]) =>
      messages
        .searchMessages(mine.id, opts)
        .map((m) => m.id)
        .sort();
    expect(ids({ query: 'turbot' })).toEqual([a, b]);
    expect(ids({ query: 'turbot', target: '#one' })).toEqual([a]);
    expect(ids({ query: 'turbot', networkId: theirNet.id })).toEqual([]);
    // New rows go through the new triggers.
    const c = add(myNet.id, '#one', 'turbot again');
    expect(ids({ query: 'turbot', target: '#one' })).toEqual([a, c]);

    // Already current: nothing is written (schema_version counts every
    // schema change this connection has seen committed).
    const before = db.pragma('schema_version', { simple: true });
    expect(mod.ensureMessagesFts()).toBe(false);
    expect(db.pragma('schema_version', { simple: true })).toBe(before);

    // One trigger gone is a stale shape too: the whole set comes back.
    db.exec(`DROP TRIGGER messages_ad`);
    expect(mod.ensureMessagesFts()).toBe(true);
    expect(sqlOf('messages_ad')).toMatch(/'delete', old\.id, old\.text, old\.buffer_id/);
    expect(ids({ query: 'turbot' })).toEqual([a, b, c]);
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`);
  });
});
