// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Proves the #490 push_subscriptions rebuild upgrades a REAL pre-existing DB
// without losing anything.
//
// Every other test in the suite gets its DB from setupTestDb, which runs the
// rebuild against a table that was created empty microseconds earlier. That
// exercises the SQL but proves nothing about the case a deploy actually hits: an
// installed database with live subscriptions in the old Web-Push-only shape. A
// rebuild is create-new → copy → DROP the original → rename, so a wrong column
// list in the copy silently drops user data and every other test stays green.
//
// So this seeds a database in the genuine pre-migration shape — the CREATE TABLE
// as it stood before #490, NOT NULL crypto columns and all — inserts rows, and
// only then imports db/index.js to run the migration for real.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-pushmig-'));
const dbPath = path.join(tmpDir, 'test.db');

// Seed BEFORE db/index.js is imported: the migration runs at import time, so the
// old-shape database has to be on disk first.
{
  const seed = new Database(dbPath);
  // Verbatim copies of the shapes as they were before #490 — deliberately not
  // imported from anywhere, because the point is to reproduce the schema a
  // deployed server is actually sitting on, not whatever the code says today.
  seed.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);
  `);
  seed.prepare(`INSERT INTO users (id, username) VALUES (1, 'alice'), (2, 'bob')`).run();
  seed
    .prepare(
      `INSERT INTO push_subscriptions
         (id, user_id, endpoint, p256dh, auth, user_agent, enabled, created_at, last_seen_at)
       VALUES
         (10, 1, 'https://push.test/alice', 'kA', 'aA', 'Firefox', 1, '2026-01-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z'),
         (11, 1, 'https://push.test/alice2', 'kA2', 'aA2', NULL, 0, '2026-01-03T00:00:00.000Z', '2026-02-04T00:00:00.000Z'),
         (12, 2, 'https://push.test/bob', 'kB', 'aB', 'Chrome', 1, '2026-01-05T00:00:00.000Z', '2026-02-06T00:00:00.000Z')`,
    )
    .run();
  seed.close();
}

process.env.DATABASE_PATH = dbPath;

let db: BetterSqlite3.Database;
let mod: typeof import('./pushSubscriptions.js');

beforeAll(async () => {
  db = (await import('./index.js')).default;
  mod = await import('./pushSubscriptions.js');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface ColumnInfo {
  name: string;
  notnull: number;
}

const columns = (): ColumnInfo[] =>
  db.prepare(`PRAGMA table_info(push_subscriptions)`).all() as ColumnInfo[];

describe('push_subscriptions rebuild (#490)', () => {
  it('preserves every existing row, with ids and metadata intact', () => {
    const rows = db.prepare(`SELECT * FROM push_subscriptions ORDER BY id`).all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(3);
    // Ids matter: a re-INSERT that renumbered them would orphan nothing visibly
    // today but would break any future row this table is joined from.
    expect(rows.map((r) => r.id)).toEqual([10, 11, 12]);
    expect(rows[0]).toMatchObject({
      user_id: 1,
      endpoint: 'https://push.test/alice',
      p256dh: 'kA',
      auth: 'aA',
      user_agent: 'Firefox',
      enabled: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: '2026-02-02T00:00:00.000Z',
    });
    // The disabled row stays disabled — a copy that defaulted enabled would
    // silently resurrect a subscription the user turned off.
    expect(rows[1]).toMatchObject({ id: 11, enabled: 0, user_agent: null });
    expect(rows[2]).toMatchObject({ id: 12, user_id: 2, endpoint: 'https://push.test/bob' });
  });

  it('backfills existing rows as webpush', () => {
    const rows = db.prepare(`SELECT transport FROM push_subscriptions`).all() as Array<{
      transport: string;
    }>;
    expect(rows.every((r) => r.transport === 'webpush')).toBe(true);
  });

  it('backfills fail_count rather than leaving it null', () => {
    // fail_count arrived via ensureColumn (#441) and the rebuild copies it, so a
    // DB that predates BOTH migrations has to come out with a usable 0 — NULL
    // would make `fail_count + 1` in recordFailure evaluate to NULL forever and
    // the disable threshold would never trigger.
    const rows = db.prepare(`SELECT fail_count FROM push_subscriptions`).all() as Array<{
      fail_count: number;
    }>;
    expect(rows.every((r) => r.fail_count === 0)).toBe(true);
  });

  it('drops NOT NULL from the Web Push crypto columns', () => {
    const cols = columns();
    expect(cols.find((c) => c.name === 'p256dh')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'auth')?.notnull).toBe(0);
    // ...while the columns that must stay required, stay required.
    expect(cols.find((c) => c.name === 'user_id')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'endpoint')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'transport')?.notnull).toBe(1);
  });

  it('recreates the user index the rebuild dropped with the table', () => {
    const idx = db.prepare(`PRAGMA index_list(push_subscriptions)`).all() as Array<{
      name: string;
    }>;
    expect(idx.some((i) => i.name === 'idx_push_subs_user')).toBe(true);
  });

  it('keeps endpoint unique', () => {
    expect(() =>
      db
        .prepare(`INSERT INTO push_subscriptions (user_id, endpoint, transport) VALUES (1, ?, ?)`)
        .run('https://push.test/alice', 'webpush'),
    ).toThrow(/UNIQUE/);
  });

  it('accepts a native subscription with no keys — the point of the rebuild', () => {
    const out = mod.upsertSubscription(1, {
      transport: 'apns',
      endpoint: 'apns-device-token-abc',
      userAgent: 'Lurker/1.0 (iPhone)',
    });
    expect(out.ok).toBe(true);
    const sub = mod.getByEndpoint('apns-device-token-abc');
    expect(sub).toMatchObject({ transport: 'apns', p256dh: null, auth: null, user_id: 1 });
  });

  it('still refuses to hand a webpush endpoint to another user', () => {
    // The pre-existing rule, unchanged by the transport work.
    const out = mod.upsertSubscription(2, {
      transport: 'webpush',
      endpoint: 'https://push.test/alice',
      p256dh: 'stolen',
      auth: 'stolen',
    });
    expect(out).toEqual({ ok: false, error: 'endpoint_owned_by_other_user' });
    expect(mod.getByEndpoint('https://push.test/alice')?.user_id).toBe(1);
  });

  it('rebinds a native device token to whoever signed in last', () => {
    // The deliberate inversion: one app install has one signed-in user, so the
    // same token under a new user means the phone changed hands. Refusing would
    // strand the new user with no way to release the token.
    mod.upsertSubscription(1, { transport: 'apns', endpoint: 'apns-shared-phone' });
    const out = mod.upsertSubscription(2, { transport: 'apns', endpoint: 'apns-shared-phone' });
    expect(out.ok).toBe(true);
    expect(mod.getByEndpoint('apns-shared-phone')?.user_id).toBe(2);
    // And alice no longer gets pushes for it.
    expect(mod.listEnabledForUser(1).some((s) => s.endpoint === 'apns-shared-phone')).toBe(false);
    expect(mod.listEnabledForUser(2).some((s) => s.endpoint === 'apns-shared-phone')).toBe(true);
  });

  it('re-enables and clears the failure streak when a device re-registers', () => {
    mod.upsertSubscription(1, { transport: 'fcm', endpoint: 'fcm-token-1' });
    const sub = mod.getByEndpoint('fcm-token-1')!;
    mod.recordFailure(sub.id);
    mod.recordFailure(sub.id);
    mod.disableSubscription(sub.id);
    expect(mod.getByEndpoint('fcm-token-1')?.enabled).toBe(false);

    mod.upsertSubscription(1, { transport: 'fcm', endpoint: 'fcm-token-1' });
    expect(mod.getByEndpoint('fcm-token-1')).toMatchObject({ enabled: true, fail_count: 0 });
  });
});
