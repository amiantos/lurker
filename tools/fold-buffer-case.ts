// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Operator fallback for case-forked buffers (#289).
//
// The schema-version-9 migration folds mixed-case buffers into one canonical
// case, but it's a one-shot — a fork that appears *after* it ran (a misbehaving
// server relaying a stray case) has nothing to clean it up. This re-runs the
// exact same merge (foldBufferCase) on demand, and additionally covers DMs and
// non-`#` channel prefixes the one-shot skipped.
//
// Usage (inside the cell container):
//   tsx tools/fold-buffer-case.ts                 # dry-run report, channels + DMs
//   tsx tools/fold-buffer-case.ts --apply         # actually fold
//   tsx tools/fold-buffer-case.ts --channels-only # restrict to '#' channels
//
// DATABASE_PATH selects the DB (same env the server uses); falls back to
// ../data/lurker.db relative to this file. Safe to run while the cell is live —
// the fold is one WAL transaction with a busy timeout — but quiet time is ideal.

import Database from 'better-sqlite3';
import path from 'path';
import {
  foldBufferCase,
  FOLD_VALIDATED_SCHEMA_VERSION,
  type FoldReport,
} from '../server/db/foldBufferCase.js';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'Fold case-forked buffers into their canonical (most-messages) casing.',
      '',
      'Usage: tsx tools/fold-buffer-case.ts [--apply] [--channels-only]',
      '',
      '  (no flags)        Dry run: report what would be folded, change nothing.',
      '  --apply           Apply the fold in a single transaction.',
      '  --channels-only   Only #-prefixed channels (the v9 migration scope).',
      '                    Default also folds DMs and &/+/! channel prefixes.',
      '',
      'DATABASE_PATH selects the database.',
    ].join('\n'),
  );
  process.exit(0);
}

const apply = argv.includes('--apply');
const scope = argv.includes('--channels-only') ? 'channels' : 'all';

const dbPath = process.env.DATABASE_PATH || path.join(import.meta.dirname, '../data/lurker.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// Refuse to run unless the DB is at the exact schema version the fold was
// audited against. A later migration could add a buffer-keyed table this fold
// doesn't know about — running blind would merge an incomplete set and leave a
// half-folded buffer. Bumping FOLD_VALIDATED_SCHEMA_VERSION (after re-auditing
// the table list) is the deliberate gate that re-enables the tool.
const hasMeta = db
  .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'`)
  .get();
const schemaVersion = hasMeta
  ? Number(
      (
        db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get() as
          | { value: string }
          | undefined
      )?.value ?? 0,
    )
  : 0;
if (schemaVersion !== FOLD_VALIDATED_SCHEMA_VERSION) {
  console.error(
    `Refusing to run: database schema_version is ${schemaVersion}, but this tool was ` +
      `validated against ${FOLD_VALIDATED_SCHEMA_VERSION}.`,
  );
  console.error(
    'The schema has changed since the fold was last audited. Re-check that foldBufferCase ' +
      'still covers every buffer-keyed table, then bump FOLD_VALIDATED_SCHEMA_VERSION.',
  );
  db.close();
  process.exit(1);
}

function printReport(report: FoldReport): void {
  const totalRows = Object.values(report.rowsAffected).reduce((a, b) => a + b, 0);
  console.log(`\nDatabase: ${dbPath}`);
  console.log(`Scope:    ${report.scope === 'all' ? 'channels + DMs' : 'channels only'}`);
  console.log(`Mode:     ${report.applied ? 'APPLIED' : 'dry run (no changes written)'}\n`);

  if (report.forks.length === 0 && totalRows === 0) {
    console.log('No forked buffers found — nothing to fold.\n');
    return;
  }

  // A row count with no forks listed is not a contradiction, and an operator
  // staring at "Forked buffers: 0" next to "messages 903000" deserves to be told
  // why before they hit --apply. History can also be rewritten to REALIGN a
  // single-cased buffer onto the casing the buffers registry holds; the fold
  // takes canon from the registry, and `forks` only lists targets that had more
  // than one casing in `messages`.
  if (report.forks.length === 0 && totalRows > 0) {
    console.log(
      'No case forks found, but rows below still move: history is being realigned\n' +
        'onto the casing the buffer registry holds. This is the display casing every\n' +
        'read path already matches exactly, so the rewrite is what makes them agree.\n',
    );
  }

  if (report.forks.length > 0) {
    console.log(`Forked buffers (${report.forks.length}):`);
    for (const f of report.forks) {
      const variants = f.variants
        .slice()
        .sort((a, b) => b.messages - a.messages)
        .map((v) => `${v.target}=${v.messages}`)
        .join(', ');
      console.log(`  net ${f.networkId}: [${variants}]  ->  ${f.canonical}`);
    }
    console.log('');
  }

  console.log(`Rows ${report.applied ? 'folded' : 'to fold'} per table:`);
  for (const [table, n] of Object.entries(report.rowsAffected)) {
    if (n > 0) console.log(`  ${table.padEnd(24)} ${n}`);
  }
  console.log(`  ${'TOTAL'.padEnd(24)} ${totalRows}\n`);

  if (!report.applied && totalRows > 0) {
    console.log('Re-run with --apply to write these changes.\n');
  }
}

try {
  const report = foldBufferCase(db, { scope, dryRun: !apply });
  printReport(report);
} finally {
  db.close();
}
