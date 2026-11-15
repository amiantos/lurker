// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Integration test for the schemaVersion-28 block: the message layout's
// `standard` choice is gone, and the Initial and Plain avatar sets are one set
// each. A stored setting naming a removed choice moves to what it became.
//
// The fixture is the real schema with schema_version wound back to 27 and the
// rows a v27 install could hold (see inviteRevivalMigration.test.ts for why a
// hand-written old DB doesn't work). No table changes shape here.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-layoutchoices-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let db: typeof import('./index.js').default;

// user id → [layout, avatar set], undefined for no row.
const before: Record<number, [string | undefined, string | undefined]> = {
  1: ['standard', 'initial-light'],
  2: ['compact', 'plain-light'],
  3: [undefined, 'plain-dark'],
  4: ['standard', 'initial-dark'],
  5: ['compact', 'ealain'],
  6: [undefined, '7'],
};

beforeAll(async () => {
  const fresh = (await import('./index.js')).default;
  fresh.close();

  const raw = new Database(dbPath);
  const user = raw.prepare(`INSERT INTO users (id, username) VALUES (?, ?)`);
  const setting = raw.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))`,
  );
  for (const [id, [layout, set]] of Object.entries(before)) {
    user.run(Number(id), `user${id}`);
    if (layout) setting.run(Number(id), 'look.message.layout', JSON.stringify(layout));
    if (set) setting.run(Number(id), 'look.avatars.set', JSON.stringify(set));
  }
  // Another key holding the same word is not this migration's.
  setting.run(1, 'look.font.family', JSON.stringify('standard'));
  raw.prepare(`UPDATE app_meta SET value = '27' WHERE key = 'schema_version'`).run();
  raw.close();

  vi.resetModules();
  ({ default: db } = await import('./index.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function stored(userId: number, key: string): unknown {
  const row = db
    .prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = ?`)
    .get(userId, key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}

describe('schema v28: settings that lost choices', () => {
  it('drops a `standard` layout to the default and leaves `compact`', () => {
    expect(stored(1, 'look.message.layout')).toBeUndefined();
    expect(stored(4, 'look.message.layout')).toBeUndefined();
    expect(stored(2, 'look.message.layout')).toBe('compact');
    expect(stored(5, 'look.message.layout')).toBe('compact');
  });

  it('drops an Initial pointer of either ink: the one Initial set is the default', () => {
    expect(stored(1, 'look.avatars.set')).toBeUndefined();
    expect(stored(4, 'look.avatars.set')).toBeUndefined();
  });

  it('moves a Plain pointer of either ink to the one Plain set', () => {
    expect(stored(2, 'look.avatars.set')).toBe('plain');
    expect(stored(3, 'look.avatars.set')).toBe('plain');
  });

  it('leaves the art set, an uploaded set and other keys alone', () => {
    expect(stored(5, 'look.avatars.set')).toBe('ealain');
    expect(stored(6, 'look.avatars.set')).toBe('7');
    expect(stored(1, 'look.font.family')).toBe('standard');
  });

  it('records the version', () => {
    const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThanOrEqual(28);
  });
});
