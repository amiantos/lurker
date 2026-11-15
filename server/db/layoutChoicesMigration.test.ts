// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Integration test for the schemaVersion-28 block: the message layouts were
// renamed Traditional and Modern, and every setting key and stored value that
// said "standard" or "compact" moved with them (shared/settingsRenames.ts), in
// user_settings and inside saved themes. The Initial and Plain avatar sets
// became one set each in the same release.
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
  4: ['auto', 'initial-dark'],
  5: ['compact', 'ealain'],
  6: [undefined, '7'],
};

const OLD_THEME = {
  'look.color.bg': '#101010',
  'look.message.compact.group_gap': 4,
  'look.message.compact.line_height': 120,
  'look.message.compact.indent': 0,
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
  // Every renamed key, each with a value that is not its default.
  setting.run(2, 'look.message.compact.group_gap', JSON.stringify(4));
  setting.run(2, 'look.message.compact.line_height', JSON.stringify(120));
  setting.run(2, 'look.message.compact.indent', JSON.stringify(3));
  setting.run(2, 'look.buffer.time_format_compact', JSON.stringify('HH:mm:ss'));
  setting.run(2, 'look.buffer.date_format_compact', JSON.stringify('DD/MM'));
  // A neighbour that keeps its name.
  setting.run(2, 'look.buffer.time_format', JSON.stringify('HH:mm'));
  const theme = raw.prepare(
    `INSERT INTO user_themes (id, user_id, name, values_json) VALUES (?, ?, ?, ?)`,
  );
  theme.run(1, 2, 'Tight', JSON.stringify(OLD_THEME));
  theme.run(2, 2, 'Colours only', JSON.stringify({ 'look.color.bg': '#202020' }));
  theme.run(3, 5, 'Broken', '{not json');
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

function theme(id: number): string {
  return (
    db.prepare(`SELECT values_json FROM user_themes WHERE id = ?`).get(id) as {
      values_json: string;
    }
  ).values_json;
}

describe('schema v28: the layouts renamed', () => {
  it('stores a `compact` layout as `modern`', () => {
    expect(stored(2, 'look.message.layout')).toBe('modern');
    expect(stored(5, 'look.message.layout')).toBe('modern');
  });

  it('drops `standard` and `auto` to the default, traditional', () => {
    expect(stored(1, 'look.message.layout')).toBeUndefined();
    expect(stored(4, 'look.message.layout')).toBeUndefined();
  });

  it('moves every renamed setting to its new key with its value', () => {
    expect(stored(2, 'look.message.modern.group_gap')).toBe(4);
    expect(stored(2, 'look.message.modern.line_height')).toBe(120);
    expect(stored(2, 'look.message.modern.indent')).toBe(3);
    expect(stored(2, 'look.buffer.time_format_modern')).toBe('HH:mm:ss');
    expect(stored(2, 'look.buffer.date_format_modern')).toBe('DD/MM');
    expect(stored(2, 'look.buffer.time_format')).toBe('HH:mm');
  });

  it('leaves no row under an old key', () => {
    const left = db
      .prepare(`SELECT key FROM user_settings WHERE key LIKE '%compact%'`)
      .all() as Array<{ key: string }>;
    expect(left).toEqual([]);
  });

  it("re-keys a saved theme's values and keeps the rest of it", () => {
    expect(JSON.parse(theme(1))).toEqual({
      'look.color.bg': '#101010',
      'look.message.modern.group_gap': 4,
      'look.message.modern.line_height': 120,
      'look.message.modern.indent': 0,
    });
    expect(JSON.parse(theme(2))).toEqual({ 'look.color.bg': '#202020' });
  });

  it('steps over a theme it cannot read', () => {
    expect(theme(3)).toBe('{not json');
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
