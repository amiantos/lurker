// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-user data import. Reads a zip produced by exportService and replays it
// into the database under the *importing* user's id. Refuses to import into an
// account that already has data — keep the flow simple and predictable: fresh
// accounts only.
//
// The archive is read straight from disk (yauzl.open, not fromBuffer) and the
// potentially-huge messages.ndjson is streamed line-by-line, inserted in
// batched transactions with a yield to the event loop between batches. That's
// the fix for lurker#180: the old path buffered the whole zip in memory and
// inserted every message in ONE synchronous transaction, which froze the event
// loop (and starved every other user's WebSocket/IRC) on a large restore.
//
// We can no longer wrap the entire import in a single transaction (you can't
// `await` a yield inside better-sqlite3's synchronous transaction), so atomicity
// is preserved differently: on any failure we wipe the account back to empty
// (resetImportedData) so the user can retry — same end state the single
// transaction's rollback used to give.

import yauzl from 'yauzl';
import type { ZipFile, Entry } from 'yauzl';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Statement, RunResult } from 'better-sqlite3';
import db from '../db/index.js';
import { EXPORT_TABLES, EXPORT_FORMAT_VERSION, IMPORT_ORDER } from '../db/exportSchema.js';
import { ENCRYPTED_NETWORK_COLUMNS } from '../db/networks.js';
import { encryptSecret } from '../utils/secretCrypto.js';

// Messages inserted per transaction before yielding to the event loop. Big
// enough that per-tx overhead is negligible, small enough that the loop never
// stalls long enough to drop a heartbeat.
const MESSAGE_BATCH = 1000;

interface ExportTableDefFull {
  mode: string;
  scope: string;
  columns: string[];
  section?: string;
  pk?: string;
  blobColumns?: string[];
  rekeyOnImport?: boolean;
  fkRekey?: Record<string, string>;
  // FK columns that should be set to NULL — rather than causing the whole
  // row to be dropped — when their referenced id is missing from the map.
  fkRekeyNullable?: string[];
}

export class ImportError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Enumerate every entry in the zip up front (reads the central directory only —
// no entry bodies). yauzl Entry objects stay valid for openReadStream while the
// ZipFile is open, so we can then read entries in the order WE need (manifest +
// data before messages), not the order archiver happened to write them.
function openZipEntries(zipPath: string): Promise<{ zip: ZipFile; entries: Map<string, Entry> }> {
  return new Promise((resolve, reject) => {
    // autoClose:false — we enumerate ALL entries first (reading past the last
    // entry), then openReadStream them in our own order. With the default
    // autoClose the ZipFile would close as soon as enumeration finished and
    // every later openReadStream would throw "closed". We close it ourselves in
    // importFromZipFile's finally.
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) {
        reject(new ImportError('not_a_zip', 'file is not a valid zip archive'));
        return;
      }
      const entries = new Map<string, Entry>();
      zip.on('error', reject);
      zip.on('entry', (entry: Entry) => {
        if (!entry.fileName.endsWith('/')) entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on('end', () => resolve({ zip, entries }));
      zip.readEntry();
    });
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err || new Error('failed to open zip entry'));
      else resolve(stream);
    });
  });
}

async function readEntryBuffer(zip: ZipFile, entry: Entry): Promise<Buffer> {
  const stream = await openEntryStream(zip, entry);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJson<T>(buf: Buffer, code: string, label: string): T {
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch (_) {
    throw new ImportError(code, `${label} is not valid JSON`);
  }
}

// "Empty" means the user hasn't set up IRC on this instance yet. We
// deliberately don't check user_settings because the client auto-syncs
// system.timezone on every bootstrap, so a fresh account always has at
// least one row there. Networks is the meaningful signal.
function accountIsEmpty(userId: number): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM networks WHERE user_id = ?').get(userId) as {
    n: number;
  };
  return row.n === 0;
}

// Build a positional INSERT for the columns we actually have. Always skips an
// autoincrement PK so the target DB assigns a fresh id.
function buildInsertStatement(
  table: string,
  def: ExportTableDefFull,
): { stmt: Statement; cols: string[] } {
  const skipCols = new Set<string>();
  if (def.pk) skipCols.add(def.pk);
  if (def.blobColumns) for (const c of def.blobColumns) skipCols.add(c);

  const cols = def.columns.filter((c) => !skipCols.has(c));
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  return { stmt: db.prepare(sql), cols };
}

function rekeyRow(
  row: Record<string, unknown>,
  def: ExportTableDefFull,
  idMaps: Record<string, Map<unknown, unknown>>,
  targetUserId: number,
): Record<string, unknown> {
  const out = { ...row };
  if (!def.fkRekey) return out;
  const nullable = new Set(def.fkRekeyNullable ?? []);
  for (const [col, target] of Object.entries(def.fkRekey)) {
    if (out[col] == null) continue;
    if (target === 'users') {
      out[col] = targetUserId;
    } else {
      const map = idMaps[target];
      const mapped = map ? map.get(out[col]) : undefined;
      if (mapped === undefined) {
        out[col] = nullable.has(col) ? null : undefined;
      } else {
        out[col] = mapped;
      }
    }
  }
  return out;
}

function insertOne(stmt: Statement, cols: string[], row: Record<string, unknown>): RunResult {
  const args = cols.map((c) => (c in row ? row[c] : null));
  return stmt.run(...args);
}

function dependsOnMessages(def: ExportTableDefFull): boolean {
  return !!(def.fkRekey && Object.values(def.fkRekey).includes('messages'));
}

// Insert all rows of one data.json table, building its id map for FK rekeying.
// Caller runs this inside a transaction.
function insertTable(
  table: string,
  data: Record<string, Record<string, unknown>[]>,
  idMaps: Record<string, Map<unknown, unknown>>,
  counts: Record<string, number>,
  targetUserId: number,
): void {
  const def = EXPORT_TABLES[table as keyof typeof EXPORT_TABLES] as ExportTableDefFull;
  const rows = data[table] || [];
  const { stmt, cols } = buildInsertStatement(table, def);

  let inserted = 0;
  for (const original of rows) {
    const row = rekeyRow(original, def, idMaps, targetUserId);

    // Export carries network secrets as plaintext; re-encrypt them at rest when
    // importing onto a keyed (hosted) cell. No-op without a key.
    if (table === 'networks') {
      // Pre-trust-toggle exports don't carry this NOT NULL column; default to
      // secure behavior during import.
      if (row.trusted_certificates === undefined) row.trusted_certificates = 1;
      for (const col of ENCRYPTED_NETWORK_COLUMNS) {
        if (typeof row[col] === 'string') row[col] = encryptSecret(row[col] as string);
      }
    }

    // If any required FK ended up undefined (referenced row wasn't in the
    // export), drop the row.
    let drop = false;
    if (def.fkRekey) {
      for (const col of Object.keys(def.fkRekey)) {
        if (row[col] === undefined) {
          drop = true;
          break;
        }
      }
    }
    if (drop) continue;

    const result = insertOne(stmt, cols, row);

    if (def.rekeyOnImport && def.pk) {
      idMaps[table] ??= new Map();
      idMaps[table].set(original[def.pk], result.lastInsertRowid);
    }
    inserted += 1;
  }
  counts[table] = inserted;
}

// Stream messages.ndjson line-by-line and insert in batched transactions,
// yielding to the event loop between batches so a large restore never stalls
// the loop. Returns the number of rows inserted. Throws ImportError on a
// malformed line (the caller wipes + retries).
async function streamMessagesInBatches(
  zip: ZipFile,
  entry: Entry,
  targetUserId: number,
  idMaps: Record<string, Map<unknown, unknown>>,
): Promise<number> {
  const def = EXPORT_TABLES.messages as ExportTableDefFull;
  const { stmt, cols } = buildInsertStatement('messages', def);
  const messagesMap = idMaps.messages;
  let inserted = 0;

  const flush = db.transaction((lines: string[]) => {
    for (const line of lines) {
      if (line.length === 0) continue;
      let original: Record<string, unknown>;
      try {
        original = JSON.parse(line) as Record<string, unknown>;
      } catch (_) {
        throw new ImportError('bad_messages', 'messages.ndjson contains a non-JSON line');
      }
      const row = rekeyRow(original, def, idMaps, targetUserId);
      // network_id is required; if it didn't map, drop the row.
      if (row.network_id === undefined) continue;
      // matched_rule_id is nullable; fall back to null if its rule wasn't exported.
      if (row.matched_rule_id === undefined) row.matched_rule_id = null;
      // from_ignored was added later; older archives omit it and the column is
      // NOT NULL, so a missing key would fail the insert.
      if (row.from_ignored === undefined) row.from_ignored = 0;
      const result = insertOne(stmt, cols, row);
      messagesMap.set(original.id, result.lastInsertRowid);
      inserted += 1;
    }
  });

  const stream = await openEntryStream(zip, entry);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let batch: string[] = [];
  for await (const line of rl) {
    batch.push(line);
    if (batch.length >= MESSAGE_BATCH) {
      flush(batch);
      batch = [];
      await yieldToEventLoop();
    }
  }
  if (batch.length) flush(batch);
  return inserted;
}

// Roll a partial import back to an empty account so the user can retry.
// Deleting the user's networks cascades every network-scoped table
// (channels/messages/buffer_reads/pinned_buffers/drafts/ignores/notes/
// input_history/highlight_rule_networks, and user_bookmarks via messages); the
// remaining tables are user-scoped roots that only cascade on user deletion, so
// we clear them explicitly. Must cover every importable user-scoped root in
// EXPORT_TABLES.
function resetImportedData(userId: number): void {
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM networks WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM highlight_rules WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM upload_history WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_away_state WHERE user_id = ?').run(userId);
    // Contacts are a user-scoped import root: contact_targets cascade away with
    // the networks above, but the contacts rows themselves only cascade on user
    // delete, so wipe them here too. Otherwise a failed-then-retried import
    // re-inserts every contact (accountIsEmpty only counts networks), leaving
    // duplicated, target-less friends.
    db.prepare('DELETE FROM contacts WHERE user_id = ?').run(userId);
  });
  wipe();
}

export interface ImportResult {
  manifest: Record<string, unknown>;
  counts: Record<string, number>;
  thumbnailsAttached: number;
}

export async function importFromZipFile(
  targetUserId: number,
  zipPath: string,
): Promise<ImportResult> {
  const { zip, entries } = await openZipEntries(zipPath);
  try {
    // ---- manifest ----
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry) {
      throw new ImportError('missing_manifest', 'archive does not contain manifest.json');
    }
    const manifest = parseJson<Record<string, unknown>>(
      await readEntryBuffer(zip, manifestEntry),
      'bad_manifest',
      'manifest.json',
    );
    if (typeof manifest.export_format_version !== 'number') {
      throw new ImportError('bad_manifest', 'manifest is missing export_format_version');
    }
    if (manifest.export_format_version > EXPORT_FORMAT_VERSION) {
      throw new ImportError(
        'format_too_new',
        `archive uses export_format_version ${manifest.export_format_version}; this server understands up to ${EXPORT_FORMAT_VERSION}`,
      );
    }

    // ---- data.json ----
    const dataEntry = entries.get('data.json');
    if (!dataEntry) {
      throw new ImportError('missing_data', 'archive does not contain data.json');
    }
    const data = parseJson<Record<string, Record<string, unknown>[]>>(
      await readEntryBuffer(zip, dataEntry),
      'bad_data',
      'data.json',
    );

    // ---- empty-account guard ----
    if (!accountIsEmpty(targetUserId)) {
      throw new ImportError(
        'account_not_empty',
        'target account already has data; imports require a fresh account',
      );
    }

    // ---- bookmarks.json (optional, small) ----
    const bookmarksEntry = entries.get('bookmarks.json');
    const bookmarks = bookmarksEntry
      ? parseJson<Record<string, unknown>[]>(
          await readEntryBuffer(zip, bookmarksEntry),
          'bad_bookmarks',
          'bookmarks.json',
        )
      : null;

    // ---- thumbnails (small JPEGs) — read up front so phase C can apply them
    // inside a synchronous transaction. ----
    const thumbs = new Map<number, Buffer>();
    for (const [name, entry] of entries) {
      const m = name.match(/^thumbnails\/(\d+)\.jpg$/);
      if (m) thumbs.set(parseInt(m[1], 10), await readEntryBuffer(zip, entry));
    }

    const counts: Record<string, number> = {};
    const idMaps: Record<string, Map<unknown, unknown>> = {};
    let thumbnailsAttached = 0;

    try {
      // ---- Phase A: data.json tables that don't depend on messages (one tx). ----
      db.transaction(() => {
        // Fresh accounts usually have an auto-synced system.timezone row; wipe
        // before insert — import replaces, doesn't merge.
        db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(targetUserId);
        for (const table of IMPORT_ORDER) {
          const def = EXPORT_TABLES[table as keyof typeof EXPORT_TABLES] as
            | ExportTableDefFull
            | undefined;
          if (!def || def.mode === 'skip') continue;
          if (def.section === 'messages' || def.section === 'bookmarks') continue;
          if (dependsOnMessages(def)) continue;
          insertTable(table, data, idMaps, counts, targetUserId);
        }
      })();

      // ---- Phase B: messages.ndjson (batched, yielding). ----
      idMaps.messages = new Map();
      const messagesEntry = entries.get('messages.ndjson');
      counts.messages = messagesEntry
        ? await streamMessagesInBatches(zip, messagesEntry, targetUserId, idMaps)
        : 0;

      // ---- Phase C: bookmarks + message-dependent tables + thumbnails (one tx). ----
      db.transaction(() => {
        if (bookmarks) {
          const def = EXPORT_TABLES.user_bookmarks as ExportTableDefFull;
          const { stmt, cols } = buildInsertStatement('user_bookmarks', def);
          let inserted = 0;
          for (const original of bookmarks) {
            const row = rekeyRow(original, def, idMaps, targetUserId);
            if (row.message_id === undefined) continue;
            insertOne(stmt, cols, row);
            inserted += 1;
          }
          counts.user_bookmarks = inserted;
        } else {
          counts.user_bookmarks = 0;
        }

        for (const table of IMPORT_ORDER) {
          const def = EXPORT_TABLES[table as keyof typeof EXPORT_TABLES] as
            | ExportTableDefFull
            | undefined;
          if (!def || def.mode === 'skip') continue;
          if (def.section === 'messages' || def.section === 'bookmarks') continue;
          if (!dependsOnMessages(def)) continue;
          insertTable(table, data, idMaps, counts, targetUserId);
        }

        if (idMaps.upload_history && thumbs.size) {
          const update = db.prepare('UPDATE upload_history SET thumbnail = ? WHERE id = ?');
          for (const [oldId, buf] of thumbs) {
            const newId = idMaps.upload_history.get(oldId);
            if (newId == null) continue;
            update.run(buf, newId);
            thumbnailsAttached += 1;
          }
        }
      })();
    } catch (err) {
      resetImportedData(targetUserId);
      if (err instanceof ImportError) throw err;
      throw new ImportError('insert_failed', `import failed: ${(err as Error).message}`);
    }

    return { manifest, counts, thumbnailsAttached };
  } finally {
    zip.close();
  }
}

// Back-compat entrypoint: accepts an in-memory buffer (used by tests and any
// caller that already has the bytes). Spills to a temp file and delegates to
// the streaming path so there's a single import implementation.
export async function importFromZipBuffer(
  targetUserId: number,
  zipBuffer: Buffer,
): Promise<ImportResult> {
  const tmp = path.join(os.tmpdir(), `lurker-import-${randomBytes(8).toString('hex')}.lurk`);
  // 0600 — the archive carries decrypted network passwords; don't leave it
  // world-readable under a permissive umask.
  await fs.promises.writeFile(tmp, zipBuffer, { mode: 0o600 });
  try {
    return await importFromZipFile(targetUserId, tmp);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}
