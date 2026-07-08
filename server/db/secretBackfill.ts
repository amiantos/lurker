// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Schema-driven at-rest re-seal of secret columns. The per-row write paths
// encrypt secrets written after LURKER_SECRET_KEY is configured; this catches
// rows that predate the key (or arrive plaintext via import / a keyless window)
// so no cleartext secret lingers in the next Litestream backup.
//
// One generic pass replaces the three near-identical siblings that used to live
// in db/networks.ts (networks, channels) and db/e2e.ts (identity + session
// keys). Which columns to wrap is declared per-table as `encryptedColumns` in
// db/exportSchema.ts and surfaced here via encryptedColumnsByTable(), so adding
// a newly-encrypted column needs no edit in this file.

import db from './index.js';
import { encryptSecret, isEncrypted, hasSecretKey } from '../utils/secretCrypto.js';
import { encryptedColumnsByTable } from './exportSchema.js';

// Wrap any plaintext values in the declared encrypted columns. Addresses rows by
// rowid (every target is a rowid table, so this works regardless of the table's
// declared PK). No-op without a key (every self-host). Safe to run on every boot
// — the isEncrypted() guard skips already-wrapped values, and the WHERE filter
// skips rows whose encrypted columns are all NULL/empty, so a fully-sealed (or
// secretless) table does zero writes. Called once from server boot, after the
// schema is ready and before IRC connects.
export function backfillEncryptColumns(map: Record<string, string[]> = encryptedColumnsByTable()): {
  scanned: number;
  encrypted: number;
} {
  if (!hasSecretKey()) return { scanned: 0, encrypted: 0 };
  let scanned = 0;
  let encrypted = 0;
  const tx = db.transaction(() => {
    for (const [table, cols] of Object.entries(map)) {
      if (cols.length === 0) continue;
      // Only rows with at least one non-empty secret can need wrapping.
      const notEmpty = cols.map((c) => `(${c} IS NOT NULL AND ${c} != '')`).join(' OR ');
      const rows = db
        .prepare(`SELECT rowid AS rid, ${cols.join(', ')} FROM ${table} WHERE ${notEmpty}`)
        .all() as Array<Record<string, string | null> & { rid: number }>;
      const update = db.prepare(
        `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE rowid = ?`,
      );
      for (const row of rows) {
        scanned += 1;
        let dirty = false;
        const next = cols.map((col) => {
          const v = row[col];
          if (typeof v === 'string' && v !== '' && !isEncrypted(v)) {
            dirty = true;
            return encryptSecret(v);
          }
          return v;
        });
        if (dirty) {
          update.run(...next, row.rid);
          encrypted += 1;
        }
      }
    }
  });
  tx();
  return { scanned, encrypted };
}
