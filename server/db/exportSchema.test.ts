// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The schema tripwire. Asserts that every live table and column in the SQLite
// schema is declared in EXPORT_TABLES — either as exported (with a column
// list) or skipped (with a reason). Adding a new table or column without
// updating exportSchema.js fails this test, which keeps the per-user data
// export honest as the schema grows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let EXPORT_TABLES: typeof import('./exportSchema.js').EXPORT_TABLES;
let FTS_SHADOW_PREFIXES: typeof import('./exportSchema.js').FTS_SHADOW_PREFIXES;
let listExportedTables: typeof import('./exportSchema.js').listExportedTables;
let listSkippedTables: typeof import('./exportSchema.js').listSkippedTables;

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ EXPORT_TABLES, FTS_SHADOW_PREFIXES, listExportedTables, listSkippedTables } =
    await import('./exportSchema.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function liveTables(): string[] {
  return (db
    .prepare(`
      SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND name NOT LIKE 'sqlite_%'
    `)
    .all() as Array<{ name: string }>)
    .map((r) => r.name)
    .filter((name) => !FTS_SHADOW_PREFIXES.some((prefix) => name.startsWith(prefix)));
}

function liveColumns(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

describe('exportSchema registry', () => {
  it('declares every live table', () => {
    const declared = new Set(Object.keys(EXPORT_TABLES));
    const live = liveTables();
    const missing = live.filter((t) => !declared.has(t));
    // tables present in the DB but missing from EXPORT_TABLES
    expect(missing).toEqual([]);
  });

  it('does not declare phantom tables', () => {
    const live = new Set(liveTables());
    const phantoms = Object.keys(EXPORT_TABLES).filter((t) => !live.has(t));
    // tables declared in EXPORT_TABLES but absent from the DB
    expect(phantoms).toEqual([]);
  });

  it('covers every column on every exported table', () => {
    const problems: string[] = [];
    for (const [table, defRaw] of Object.entries(EXPORT_TABLES)) {
      const def = defRaw as Record<string, unknown>;
      if (def['mode'] !== 'export' && def['mode'] !== 'partial') continue;
      const cols = liveColumns(table);
      const exported = new Set((def['columns'] as string[] | undefined) ?? []);
      const skipped = new Set(Object.keys((def['skippedColumns'] as Record<string, string> | undefined) ?? {}));
      for (const col of cols) {
        if (!exported.has(col) && !skipped.has(col)) {
          problems.push(`${table}.${col} is not in columns or skippedColumns`);
        }
      }
      for (const col of (def['columns'] as string[] | undefined) ?? []) {
        if (!cols.includes(col)) {
          problems.push(`${table}.${col} declared in exportSchema but not present in DB`);
        }
      }
      for (const col of Object.keys((def['skippedColumns'] as Record<string, string> | undefined) ?? {})) {
        if (!cols.includes(col)) {
          problems.push(`${table}.${col} listed in skippedColumns but not present in DB`);
        }
      }
    }
    // problems list is printed as the failure description
    expect(problems).toEqual([]);
  });

  it('requires a reason for every skipped table', () => {
    const problems: string[] = [];
    for (const [table, defRaw] of Object.entries(EXPORT_TABLES)) {
      const def = defRaw as Record<string, unknown>;
      if (def['mode'] !== 'skip') continue;
      if (!def['reason'] || typeof def['reason'] !== 'string' || def['reason'].trim() === '') {
        problems.push(`${table}: missing reason`);
      }
    }
    // problems list is printed as the failure description
    expect(problems).toEqual([]);
  });

  it('requires a reason for every skipped column on a partial table', () => {
    const problems: string[] = [];
    for (const [table, defRaw] of Object.entries(EXPORT_TABLES)) {
      const def = defRaw as Record<string, unknown>;
      if (def['mode'] !== 'partial') continue;
      for (const [col, reason] of Object.entries((def['skippedColumns'] as Record<string, unknown> | undefined) ?? {})) {
        if (!reason || typeof reason !== 'string' || reason.trim() === '') {
          problems.push(`${table}.${col}: missing reason`);
        }
      }
    }
    // problems list is printed as the failure description
    expect(problems).toEqual([]);
  });

  it('uses recognized mode values', () => {
    const valid = new Set(['export', 'partial', 'skip']);
    const problems: string[] = [];
    for (const [table, defRaw] of Object.entries(EXPORT_TABLES)) {
      const def = defRaw as Record<string, unknown>;
      if (!valid.has(def['mode'] as string)) problems.push(`${table}: unknown mode "${def['mode']}"`);
    }
    expect(problems).toEqual([]);
  });

  it('only references exporter-known tables in fkRekey', () => {
    const exported = new Set([...listExportedTables(), 'users']);
    const problems: string[] = [];
    for (const [table, defRaw] of Object.entries(EXPORT_TABLES)) {
      const def = defRaw as Record<string, unknown>;
      const fk = (def['fkRekey'] as Record<string, string> | undefined) ?? {};
      for (const [col, target] of Object.entries(fk)) {
        if (!exported.has(target)) {
          problems.push(`${table}.${col} → ${target} (not an exported table)`);
        }
      }
    }
    // problems list is printed as the failure description
    expect(problems).toEqual([]);
  });
});

describe('listExportedTables / listSkippedTables', () => {
  it('partitions the registry without overlap', () => {
    const exported = new Set(listExportedTables());
    const skipped = new Set(listSkippedTables());
    const overlap = [...exported].filter((t) => skipped.has(t));
    expect(overlap).toEqual([]);
    expect(exported.size + skipped.size).toBe(Object.keys(EXPORT_TABLES).length);
  });
});
