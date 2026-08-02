// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Drift detection for BUFFER_KEYED_TABLES.
//
// The registry is a hand-written list of every table storing a buffer target as
// a string, and the whole rename machinery trusts it to be complete. A hand
// written list of that kind rots: the previous one (foldBufferCase's
// TARGET_TABLES) stopped being updated around schema 9 and by schema 16 named
// two tables that no longer existed, which the version guard hid rather than
// surfaced.
//
// So this doesn't check the list against another list. It introspects the schema
// the migrations actually produced and compares reality to the declaration, in
// both directions.

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BUFFER_KEYED_TABLES,
  CURRENT_BUFFER_KEYED_TABLES,
  BUFFER_TARGET_COLUMN_NAMES,
  NON_BUFFER_TARGET_TABLES,
} from './bufferKeyedTables.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-buftables-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;

interface ColumnRow {
  name: string;
  type: string;
}

function tableNames(): string[] {
  return (
    (
      db
        // Only SQLite's own internal tables are filtered, and with ESCAPE because
        // `_` is a single-character LIKE wildcard. FTS5 shadow tables are left in
        // deliberately: they carry no target/channel column, so they can't trip
        // the completeness check, and a pattern broad enough to exclude them is a
        // pattern broad enough to exclude a real table by accident. It already
        // did — `%_fts%` matches `user_drafts`, because "drafts" ends in "fts".
        .prepare(
          `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
  );
}

function columns(table: string): ColumnRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnRow[];
}

beforeAll(async () => {
  ({ default: db } = await import('./index.js'));
});

describe('BUFFER_KEYED_TABLES completeness', () => {
  it('declares every table in the live schema with a buffer-target column', () => {
    const declared = new Set(BUFFER_KEYED_TABLES.map((t) => t.table));
    const exempt = new Set(NON_BUFFER_TARGET_TABLES);

    const undeclared: string[] = [];
    for (const table of tableNames()) {
      if (declared.has(table) || exempt.has(table)) continue;
      const hit = columns(table).find((c) => BUFFER_TARGET_COLUMN_NAMES.includes(c.name));
      if (hit) undeclared.push(`${table}.${hit.name}`);
    }

    // A new buffer-keyed table has to be added to BUFFER_KEYED_TABLES (with a
    // collision policy) so renameBuffer visits it. If the column only looks like
    // a buffer target and isn't one, add the table to NON_BUFFER_TARGET_TABLES
    // with a reason — but read renameBuffer first and be sure.
    expect(undeclared).toEqual([]);
  });

  it('declares no table or column that the live schema lacks', () => {
    // The reverse drift, and the one that actually broke the fold: a declared
    // table that has since been dropped. Legacy entries are exempt by
    // definition — a fresh install never creates them.
    const live = new Set(tableNames());
    const missing: string[] = [];
    for (const t of CURRENT_BUFFER_KEYED_TABLES) {
      if (!live.has(t.table)) {
        missing.push(t.table);
        continue;
      }
      const names = new Set(columns(t.table).map((c) => c.name));
      for (const col of [t.column, t.derivedColumn, ...t.scope].filter(Boolean) as string[]) {
        if (!names.has(col)) missing.push(`${t.table}.${col}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('marks exactly the COLLATE NOCASE target columns as caseInsensitive', () => {
    // caseInsensitive is what lets foldBufferCase skip a table. Getting it wrong
    // in one direction makes the fold do pointless work; in the other it makes
    // the fold miss a real case fork.
    const mismatches: string[] = [];
    for (const t of CURRENT_BUFFER_KEYED_TABLES) {
      const ddl = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(t.table) as { sql: string } | undefined
      )?.sql;
      if (!ddl) continue;
      const decl = new RegExp(`\\b${t.column}\\b[^,]*`, 'i').exec(ddl)?.[0] ?? '';
      const nocase = /COLLATE\s+NOCASE/i.test(decl);
      if (nocase !== !!t.caseInsensitive) {
        mismatches.push(`${t.table}.${t.column}: schema=${nocase} declared=${!!t.caseInsensitive}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('has no duplicate table entries', () => {
    const names = BUFFER_KEYED_TABLES.map((t) => t.table);
    expect(names.length).toBe(new Set(names).size);
  });
});

describe('the retired tables really are retired', () => {
  it('does not create channels or closed_buffers on a fresh install', () => {
    // Pins the reason the legacy entries exist. If a fresh install ever grows
    // these back, the existence gates around them are wrong.
    const live = new Set(tableNames());
    expect(live.has('channels')).toBe(false);
    expect(live.has('closed_buffers')).toBe(false);
  });
});
