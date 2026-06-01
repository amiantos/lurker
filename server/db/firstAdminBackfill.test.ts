// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Node edition + a throwaway DB, set before any db import. In node edition a
// cell has no operator-admin, so the "promote the first user" recovery must NOT
// fire — otherwise a restart would silently make a tenant an admin.
process.env.LURKER_EDITION = 'node';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-firstadmin-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

// Seed tenant users (no admin) BEFORE importing ./index.js, so the module-load
// migration runs against an existing population — i.e. the real cell-restart
// path, where migrate() + backfillFirstAdmin() see pre-existing rows.
{
  const seed = new Database(process.env.DATABASE_PATH);
  seed.exec(
    `CREATE TABLE users (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       username TEXT UNIQUE NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  const insert = seed.prepare('INSERT INTO users (username) VALUES (?)');
  insert.run('tenant-a');
  insert.run('tenant-b');
  seed.close();
}

let index: typeof import('./index.js');
let users: typeof import('./users.js');

beforeAll(async () => {
  // Importing ./index.js runs migrate() + backfillFirstAdmin() against the
  // already-seeded users — exactly what happens when a node cell restarts.
  index = await import('./index.js');
  users = await import('./users.js');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('backfillFirstAdmin in node edition', () => {
  it('does not promote a pre-existing tenant on startup (the cell-restart path)', () => {
    // The startup migration just ran against two seeded tenants — neither should
    // have been promoted, and the role column should default everyone to 'user'.
    expect(users.countAdmins()).toBe(0);
    expect(users.listUsers().every((u) => u.role === 'user')).toBe(true);

    // An explicit re-run remains a no-op too.
    index.backfillFirstAdmin();
    expect(users.countAdmins()).toBe(0);
  });
});
