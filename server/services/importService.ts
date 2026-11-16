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
import { Transform } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { Statement, RunResult } from 'better-sqlite3';
import db from '../db/index.js';
import {
  EXPORT_TABLES,
  EXPORT_FORMAT_VERSION,
  IMPORT_ORDER,
  historyFileTables,
} from '../db/exportSchema.js';
import {
  seedAllBuffersDirty,
  clearNoiseCursorForUser,
  beginImport,
  endImport,
} from '../db/retention.js';
import { getOption } from './settingsRegistry.js';
import { isBuiltinThemeId, THEME_POINTER_KEYS } from '../../shared/themePresets.js';
import themesService from './themesService.js';
import avatarSetsService, { AVATAR_SET_POINTER_KEY } from './avatarSetsService.js';
import {
  AVATAR_SET_IMAGE_MAX_BYTES,
  AVATAR_SET_MAX_TILES,
  AVATAR_SET_UNPACKED_MAX_BYTES,
} from '../../shared/avatarSets.js';
import { currentAvatarSetId, isBuiltinAvatarSetId } from '../../shared/avatarTiles.js';
import {
  LAYOUT_SETTING_KEY,
  currentLayoutValue,
  currentSettingKey,
  withCurrentSettingKeys,
} from '../../shared/settingsRenames.js';
import { encryptSecret } from '../utils/secretCrypto.js';
import {
  importRow as importBufferRow,
  reopen as reopenBuffer,
  ensureServerBuffer,
  ensureSystemBuffer,
  foldTargetFor,
  invalidateCasemappingCache,
} from '../db/buffers.js';
import { resolveBuffer } from '../db/bufferResolve.js';
import { listBufferTargets, hasMessageForTarget } from '../db/messages.js';
import { resolveOrMintForInsert } from '../db/bufferResolve.js';
import { migrateSmartFilterToEventMode } from '../db/migrateEventMode.js';
import ignoreRulesService from './ignoreRulesService.js';
import type { IgnorePatternKind } from '../db/ignoredMasks.js';

// Messages inserted per transaction before yielding to the event loop. Big
// enough that per-tx overhead is negligible, small enough that the loop never
// stalls long enough to drop a heartbeat.
const MESSAGE_BATCH = 1000;

// What an archive may make this process hold in memory at once. The upload
// route caps the COMPRESSED archive (500 MB); DEFLATE reaches ~1000:1 on
// repetitive JSON, so without these a few megabytes inflated to gigabytes in
// the heap of the one process serving every user. Each bound is on bytes
// actually read: the zip header's uncompressedSize is the archive's claim, not
// a measurement. Overridable per call so a test can hit them with a small
// archive rather than a large one.
export interface ImportLimits {
  /** manifest.json: a handful of fields. */
  manifestBytes: number;
  /** data.json and each <section>.json (bookmarks, reactions): every
   *  non-message row of the account, read whole. */
  jsonBytes: number;
  /** One upload thumbnail; the pipeline renders them at 512px. */
  thumbnailBytes: number;
  /** All thumbnails together — they are held until phase C. */
  thumbnailsTotalBytes: number;
  /** One messages.ndjson line: a row is one IRC line plus its columns. */
  ndjsonLineBytes: number;
  /** Central-directory entries, each a yauzl object held for the import. */
  entries: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  manifestBytes: 64 * 1024,
  jsonBytes: 256 * 1024 * 1024,
  thumbnailBytes: 2 * 1024 * 1024,
  thumbnailsTotalBytes: 256 * 1024 * 1024,
  ndjsonLineBytes: 1024 * 1024,
  entries: 100_000,
};

interface ExportTableDefFull {
  mode: string;
  scope: string;
  columns: string[];
  section?: string;
  pk?: string;
  blobColumns?: string[];
  encryptedColumns?: string[];
  rekeyOnImport?: boolean;
  fkRekey?: Record<string, string>;
  // FK columns that should be set to NULL — rather than causing the whole
  // row to be dropped — when their referenced id is missing from the map.
  fkRekeyNullable?: string[];
  // A row the table already holds (by a UNIQUE key) is skipped, not an error —
  // as the table's live insert treats one — so a duplicate in the archive can't
  // fail the whole import.
  insertOrIgnore?: boolean;
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
function openZipEntries(
  zipPath: string,
  maxEntries: number,
): Promise<{ zip: ZipFile; entries: Map<string, Entry> }> {
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
      // Every central-directory record counts, directories included: each is
      // parsed on the event loop whether or not it is kept.
      let seen = 0;
      zip.on('error', reject);
      zip.on('entry', (entry: Entry) => {
        seen += 1;
        if (seen > maxEntries) {
          // Rejecting here means the caller never gets the ZipFile to close.
          zip.close();
          reject(
            new ImportError('too_many_entries', `archive has more than ${maxEntries} entries`),
          );
          return;
        }
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

async function readEntryBuffer(zip: ZipFile, entry: Entry): Promise<Buffer>;
async function readEntryBuffer(zip: ZipFile, entry: Entry, max: number): Promise<Buffer | null>;
// With `max`, an entry whose bytes run past it (whatever its header said)
// answers null, read no further than that.
async function readEntryBuffer(zip: ZipFile, entry: Entry, max?: number): Promise<Buffer | null> {
  const stream = await openEntryStream(zip, entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (max !== undefined && size > max) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// The read every whole-entry consumer makes: past `max` bytes the archive is
// refused, whatever its headers claimed.
async function readEntryBounded(
  zip: ZipFile,
  entry: Entry,
  label: string,
  max: number,
): Promise<Buffer> {
  const buf = await readEntryBuffer(zip, entry, max);
  if (buf === null) {
    throw new ImportError('entry_too_large', `${label} is larger than ${max} bytes`);
  }
  return buf;
}

// readline buffers a line until its newline arrives, so one newline-less line
// is the whole entry in memory. This passes bytes through until a line runs
// past `max`, then ends the stream early and reports the overflow; the caller
// checks `overflowed()` after the last line and refuses the archive.
function boundLineLength(
  input: NodeJS.ReadableStream,
  max: number,
): { stream: Transform; overflowed: () => boolean } {
  let run = 0;
  let overflowed = false;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let pos = 0;
      let over = false;
      while (pos < chunk.length) {
        // readline ends a line at \n, \r or \r\n; a bare \r must count here
        // too, or a CR-separated archive reads as one long line.
        const lf = chunk.indexOf(10, pos);
        const cr = chunk.indexOf(13, pos);
        const term = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
        const end = term === -1 ? chunk.length : term;
        run += end - pos;
        if (run > max) {
          over = true;
          break;
        }
        if (term === -1) break;
        run = 0;
        pos = term + 1;
      }
      if (over) {
        overflowed = true;
        input.unpipe(stream);
        (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        callback();
        stream.end();
        return;
      }
      callback(null, chunk);
    },
  });
  // pipe() installs no error handler on its source. yauzl reports a corrupt
  // entry (bad DEFLATE bytes, a size that disagrees with the header) as an
  // 'error' on the entry stream, which readline used to re-emit so the import
  // failed cleanly; with nothing listening it is an uncaughtException. Hand it
  // to the Transform so readline still sees it.
  input.on('error', (err) => stream.destroy(err as Error));
  input.pipe(stream);
  return { stream, overflowed: () => overflowed };
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
export function accountIsEmpty(userId: number): boolean {
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
  const verb = def.insertOrIgnore ? 'INSERT OR IGNORE' : 'INSERT';
  const sql = `${verb} INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
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

// What a column takes when an archive predates it: the table's own default,
// read once per table from the schema. An older archive lacks every column
// added since it was written (trusted_certificates, position, proxy_enabled,
// flood_protection, …), and binding NULL for a NOT NULL one refused the row
// and so the whole restore. Only literal defaults are honoured — a number or a
// quoted string, which is what the ensureColumn migrations declare; an
// expression (created_at's strftime) is left to NULL as before, and every
// archive carries that column anyway.
const tableDefaults = new Map<string, Map<string, unknown>>();
function columnDefaults(table: string): Map<string, unknown> {
  let defaults = tableDefaults.get(table);
  if (defaults) return defaults;
  defaults = new Map();
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  for (const col of info) {
    const raw = col.dflt_value;
    if (!col.notnull || raw === null) continue;
    if (/^-?\d+(\.\d+)?$/.test(raw)) defaults.set(col.name, Number(raw));
    else if (/^'.*'$/s.test(raw)) defaults.set(col.name, raw.slice(1, -1).replace(/''/g, "'"));
  }
  tableDefaults.set(table, defaults);
  return defaults;
}

function insertOne(stmt: Statement, cols: string[], row: Record<string, unknown>): RunResult {
  const args = cols.map((c) => (c in row ? row[c] : null));
  return stmt.run(...args);
}

function dependsOnMessages(def: ExportTableDefFull): boolean {
  return !!(def.fkRekey && Object.values(def.fkRekey).includes('messages'));
}

// The buffer_id-keyed view-state tables (schema 18). Only these get the
// v1-archive name→id derivation below.
const SATELLITE_BUFFER_TABLES = new Set([
  'buffer_reads',
  'input_history',
  'pinned_buffers',
  'nicklist_collapsed',
  'channel_notify_settings',
  'user_drafts',
]);

/** Resolve an archive row's (networkId, target) — already mapped to THIS
 *  install's network id — to a buffer id. Sentinel targets mint/attach to
 *  this install's own consoles. */
function resolveArchiveBufferId(
  userId: number,
  networkId: number | null,
  target: string,
): number | undefined {
  if (!target) return undefined;
  if (target.startsWith(':')) {
    if (networkId == null || target === ':system:') return ensureSystemBuffer(userId).id;
    return ensureServerBuffer(networkId)?.id;
  }
  if (networkId == null) return undefined;
  return resolveBuffer(userId, networkId, target)?.id;
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

  // Settings keys the archive holds under their current name. A row under a
  // key's old name is dropped where the archive has both (an older server can
  // end up with both), not re-keyed onto the same (user, key) twice.
  const currentKeys =
    table === 'user_settings'
      ? new Set(
          rows
            .map((r) => r?.key)
            .filter((k) => typeof k === 'string' && currentSettingKey(k) === k),
        )
      : null;

  let inserted = 0;
  for (const original of rows) {
    const row = rekeyRow(original, def, idMaps, targetUserId);

    // A column the archive predates takes the table's default (a pre-toggle
    // archive imports with trusted_certificates on, flood protection on).
    for (const [col, value] of columnDefaults(table)) {
      if (row[col] === undefined) row[col] = value;
    }

    // target_folded is derived state (the registry's one folded lookup key);
    // recompute rather than trusting the archive so a hand-edited or corrupted
    // file can't plant a row the folded lookups will never find. Folded
    // per-network (#707): network_id is already rekeyed and networks import
    // before buffers, so the just-imported casemapping governs — a legacy
    // toLowerCase here would write folds the message import's own resolver
    // then misses, minting duplicate buffers mid-restore (and colliding
    // outright on ascii-network case-twins), while the healing refold never
    // runs because the imported mapping makes the next connect a no-op.
    if (table === 'buffers') {
      row.target_folded = foldTargetFor(
        (row.network_id as number | null) ?? null,
        String(row.target ?? ''),
      );
      // Sentinel rows (:system:, :server:<id>) are install-local: the target
      // account already owns its :system: row (minted at account creation —
      // inserting the archive's copy violates idx_buffers_key), and an
      // archived ':server:<oldNetId>' target embeds the SOURCE install's
      // network id, which nothing on this install will ever ask for. The
      // target install mints its own sentinels on first use.
      if (String(row.target ?? '').startsWith(':')) continue;
    }

    // v1-archive fallback for the buffer_id-keyed view-state tables: pre-v2
    // rows carry (network_id, target) instead of buffer_id. Derive it against
    // the already-imported registry (Phase A puts `buffers` before all of
    // these) — the old network id maps through idMaps.networks explicitly,
    // since most of these tables no longer declare network_id as a column.
    // ':'-prefixed targets route to this install's own sentinels, which is
    // strictly better than v1-era behavior: an archived server-console read
    // pointer used to strand under ':server:<oldNetId>'; now it lands on the
    // network's real console. Unresolvable rows drop, same as any unmapped FK.
    if (SATELLITE_BUFFER_TABLES.has(table) && row.buffer_id === undefined) {
      const target = typeof original.target === 'string' ? original.target : '';
      const oldNet = original.network_id;
      const mappedNet =
        oldNet == null ? null : (idMaps.networks?.get(oldNet) as number | undefined);
      if (oldNet != null && mappedNet === undefined) continue; // network wasn't imported
      row.buffer_id = resolveArchiveBufferId(targetUserId, mappedNet ?? null, target);
      if (row.buffer_id === undefined) continue;
      if (table === 'pinned_buffers' && row.network_id == null) row.network_id = mappedNet;
    }

    // Export carries at-rest secrets (network passwords, +k channel keys) as
    // plaintext; re-encrypt them when importing onto a keyed (hosted) cell.
    // No-op without a key. Which columns is declared per-table via
    // `encryptedColumns` in exportSchema.ts.
    if (def.encryptedColumns) {
      for (const col of def.encryptedColumns) {
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

    // `uploads.uploader_id` is an uploader_config row id that lives inside a
    // user_settings VALUE, so the column-based FK-rekey machinery above can't see
    // it — this is the one id in the archive that has to be rewritten by hand
    // (#514). Unmapped means it pointed at an INSTANCE uploader (never exported),
    // so drop the setting entirely and let the user land on the target instance's
    // default rather than on a dangling id.
    if (table === 'user_settings' && row.key === 'uploads.uploader_id') {
      let oldId: unknown;
      try {
        oldId = JSON.parse(String(row.value));
      } catch {
        continue; // malformed archive value — drop the setting, fall back to default
      }
      const mapped = idMaps.uploader_config?.get(oldId);
      if (mapped === undefined) continue;
      row.value = JSON.stringify(mapped);
    }

    // Same in-VALUE rewrite for the theme pointers: their value is a user_themes
    // row id as a decimal STRING (or a built-in id, which travels as-is). A
    // pointer whose theme didn't survive the trip drops and falls back to its
    // registry default — the resolver treats that as the built-in Dark theme.
    if (
      table === 'user_settings' &&
      typeof row.key === 'string' &&
      THEME_POINTER_KEYS.includes(row.key)
    ) {
      let oldId: unknown;
      try {
        oldId = JSON.parse(String(row.value));
      } catch {
        continue;
      }
      if (typeof oldId !== 'string') continue;
      if (!isBuiltinThemeId(oldId)) {
        // Only a canonical decimal string is a pointer. '012' or '2e0' never
        // resolved on any client (exact-string byId), so rewriting them through
        // Number() would turn a dead value into a live pointer.
        const n = Number(oldId);
        if (!Number.isInteger(n) || String(n) !== oldId) continue;
        const mapped = idMaps.user_themes?.get(n);
        if (mapped === undefined) continue;
        row.value = JSON.stringify(String(mapped));
      }
    }

    // An archive from before the layouts were renamed (schema v28) lands as
    // that migration would have left the install it came from: a setting under
    // the key it has now, and the layout itself under its new name, or dropped
    // to the default where the old choice is gone.
    if (table === 'user_settings' && typeof row.key === 'string') {
      const now = currentSettingKey(row.key);
      if (now !== row.key && currentKeys?.has(now)) continue;
      row.key = now;
      if (row.key === LAYOUT_SETTING_KEY) {
        let was: unknown;
        try {
          was = JSON.parse(String(row.value));
        } catch {
          continue;
        }
        const now = currentLayoutValue(was);
        if (now === null) continue;
        row.value = JSON.stringify(now);
      }
    }

    // The avatar-set pointer (#607): same shape as the theme pointers, with
    // the built-in ids ('ealain', 'plain', 'initial') travelling as-is, and
    // one from before Initial and Plain were a set each moved to its set.
    if (
      table === 'user_settings' &&
      typeof row.key === 'string' &&
      row.key === AVATAR_SET_POINTER_KEY
    ) {
      let oldId: unknown;
      try {
        oldId = JSON.parse(String(row.value));
      } catch {
        continue;
      }
      if (typeof oldId !== 'string') continue;
      if (oldId !== currentAvatarSetId(oldId)) {
        row.value = JSON.stringify(currentAvatarSetId(oldId));
      } else if (!isBuiltinAvatarSetId(oldId)) {
        const n = Number(oldId);
        if (!Number.isInteger(n) || String(n) !== oldId) continue;
        const mapped = idMaps.avatar_sets?.get(n);
        if (mapped === undefined) continue;
        row.value = JSON.stringify(String(mapped));
      }
    }

    // Saved themes route through the service (same reasoning as ignored_masks
    // below): a crafted/edited archive must not plant what POST /api/themes
    // would 400 — non-themed keys, type-invalid values, reserved/over-long
    // names, rows past the cap, or case-twin names that would abort the whole
    // import on the NOCASE UNIQUE constraint. An invalid theme drops alone;
    // its pointer rewrite above then misses and the pointer falls back to the
    // built-in Dark theme.
    if (table === 'user_themes') {
      let values: unknown;
      try {
        values = JSON.parse(String(row.values_json));
      } catch {
        continue;
      }
      // Under the keys the settings have now: the service drops a key it does
      // not know, and an older archive's density values would go with it.
      if (values && typeof values === 'object' && !Array.isArray(values)) {
        values = withCurrentSettingKeys(values as Record<string, unknown>);
      }
      const result = themesService.create(row.user_id as number, { name: row.name, values });
      if (!result.ok) continue;
      idMaps.user_themes ??= new Map();
      idMaps.user_themes.set(original.id, result.theme.id);
      inserted += 1;
      continue;
    }

    // Route ignore rules through the service rather than a raw INSERT, so a
    // crafted/legacy archive can't plant an unvalidated regex (ReDoS surface), a
    // non-ISO expires_at that never lapses and never sweeps, or a duplicate —
    // the service runs the same validation/normalization/dedupe as live /ignore.
    // Pre-overhaul archives carry only mask/created_at; the defaults below
    // reproduce the migration's "ALL-level substring rule".
    if (table === 'ignored_masks') {
      const csv = (v: unknown): string[] | null =>
        typeof v === 'string' && v ? v.split(',').filter(Boolean) : null;
      const result = ignoreRulesService.add(row.user_id as number, row.network_id as number, {
        mask: typeof row.mask === 'string' ? row.mask : null,
        channels: csv(row.channels),
        pattern: typeof row.pattern === 'string' ? row.pattern : null,
        patternKind: ((row.pattern_kind as IgnorePatternKind) || 'substr') as IgnorePatternKind,
        levels: csv(row.levels) ?? ['ALL'],
        isExcept: row.is_except === 1 || row.is_except === true,
        expiresAt: typeof row.expires_at === 'string' ? row.expires_at : null,
      });
      if (result.ok) inserted += 1;
      continue;
    }

    // nick_folded is derived state, folded as the live insert folds it
    // (db/reactions.ts addReaction) — recomputed rather than trusted, or an edited
    // archive could plant a reaction its sender's unreact never matches.
    if (table === 'message_reactions') {
      row.nick_folded = String(row.nick ?? '').toLowerCase();
    }

    const result = insertOne(stmt, cols, row);
    if (result.changes === 0) continue; // insertOrIgnore skipped a duplicate

    if (def.rekeyOnImport && def.pk) {
      idMaps[table] ??= new Map();
      idMaps[table].set(original[def.pk], result.lastInsertRowid);
    }
    inserted += 1;
  }
  counts[table] = inserted;
}

// Legacy-archive conversion: build buffers-registry rows for an export that
// predates the registry (no `buffers` table; existence derived from messages,
// autojoin/key in `channels`, hide flags in `closed_buffers`). Mirrors the
// schema-16 backfill: message targets → open rows; channels rows → autojoin/key
// carriers ('closed' + NULL closed_at when history-less, i.e. never surfaced);
// closed_buffers → closed (flag wins, archive closed_at preserved). Folding
// dedupe happens inside importBufferRow's folded conflict handling; canonical
// casing = first-seen (listBufferTargets is target ASC), which is deterministic
// — the operator fold tool can re-canonicalize a pre-v9 archive's forks.
function convertLegacyBuffers(
  data: Record<string, Record<string, unknown>[]>,
  idMaps: Record<string, Map<unknown, unknown>>,
  counts: Record<string, number>,
  targetUserId: number,
): void {
  // Legacy is detected by the presence of the legacy TABLES, not by
  // data.buffers being empty — a modern archive from a user with zero buffer
  // rows must not have registry rows synthesized from its message history.
  if (!('channels' in data) && !('closed_buffers' in data)) return;
  const legacyChannels = data.channels || [];
  const legacyClosed = data.closed_buffers || [];
  const networkMap = idMaps.networks;
  if (!networkMap || (!legacyChannels.length && !legacyClosed.length && !networkMap.size)) return;

  let converted = 0;
  // A: every imported message target becomes an open row. The message stream
  // already minted these rows (insertMessage's defensive mint materializes
  // unknown targets CLOSED so it can never conjure a surfaced buffer), and
  // importRow's conflict policy deliberately never flips closed→open — so the
  // "message targets are open" rule is applied with an explicit reopen. The
  // closed_buffers pass below still wins last, exactly as before.
  for (const newNetworkId of networkMap.values()) {
    for (const target of listBufferTargets(newNetworkId as number)) {
      if (target.startsWith(':')) continue; // sentinel rows keep their own state
      importBufferRow({
        userId: targetUserId,
        networkId: newNetworkId as number,
        target,
        state: 'open',
      });
      reopenBuffer(targetUserId, newNetworkId as number, target);
      converted += 1;
    }
  }
  // B: channels rows carry autojoin + key; history decides surfaced-ness.
  for (const ch of legacyChannels) {
    const networkId = networkMap.get(ch.network_id);
    if (networkId === undefined || typeof ch.name !== 'string' || !ch.name) continue;
    importBufferRow({
      userId: targetUserId,
      networkId: networkId as number,
      target: ch.name,
      kind: 'channel',
      state: hasMessageForTarget(networkId as number, ch.name) ? 'open' : 'closed',
      autojoin: ch.joined === 1 || ch.joined === true,
      key: typeof ch.key === 'string' ? ch.key : null,
    });
    converted += 1;
  }
  // C: closed flags win last.
  for (const cb of legacyClosed) {
    const networkId = networkMap.get(cb.network_id);
    if (networkId === undefined || typeof cb.target !== 'string' || !cb.target) continue;
    importBufferRow({
      userId: targetUserId,
      networkId: networkId as number,
      target: cb.target,
      state: 'closed',
      closedAt: typeof cb.closed_at === 'string' ? cb.closed_at : null,
    });
    converted += 1;
  }
  if (converted > 0) counts.buffers = (counts.buffers ?? 0) + converted;
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
  maxLineBytes: number,
): Promise<number> {
  const def = EXPORT_TABLES.messages as ExportTableDefFull;
  // buffer_id is not an archive column (archives carry names; ids are
  // install-local), but the live table's invariant is "never NULL" — an
  // imported row with a NULL buffer_id would be invisible to every id-keyed
  // read. Stamped per row below, resolved against the already-imported
  // buffers rows (IMPORT_ORDER puts `buffers` in Phase A, before messages);
  // anything a legacy archive fails to resolve gets the same defensive
  // closed-mint the insert path uses.
  const defWithBufferId = { ...def, columns: [...def.columns, 'buffer_id'] };
  const { stmt, cols } = buildInsertStatement('messages', defWithBufferId);
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
      // mirrored (#439) was added later too — same NOT NULL fallback so a
      // pre-#439 archive (no `mirrored` key) doesn't fail the insert.
      if (row.mirrored === undefined) row.mirrored = 0;
      // notable (#470) was added later — pre-#470 archives omit it and the column
      // is NOT NULL. Default to 1 (notable), matching the column default: old
      // history predates the server-buffer notability model, so it all counts.
      if (row.notable === undefined) row.notable = 1;
      // reply_to_self (#993) is NOT NULL too; a pre-reply archive has no replies.
      if (row.reply_to_self === undefined) row.reply_to_self = 0;
      row.buffer_id = resolveOrMintForInsert(row.network_id as number, String(row.target ?? ''));
      const result = insertOne(stmt, cols, row);
      messagesMap.set(original.id, result.lastInsertRowid);
      inserted += 1;
    }
  });

  const bounded = boundLineLength(await openEntryStream(zip, entry), maxLineBytes);
  const rl = readline.createInterface({ input: bounded.stream, crlfDelay: Infinity });
  let batch: string[] = [];
  for await (const line of rl) {
    batch.push(line);
    if (batch.length >= MESSAGE_BATCH) {
      flush(batch);
      batch = [];
      await yieldToEventLoop();
    }
  }
  if (bounded.overflowed()) {
    throw new ImportError(
      'entry_too_large',
      `messages.ndjson has a line longer than ${maxLineBytes} bytes`,
    );
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
  // The buffers import folds through the casemapping cache mid-transaction,
  // and the rollback that lands us here reverts sqlite_sequence — so the
  // rolled-back network ids (cached with the rolled-back mappings) are
  // exactly the ids the next createNetwork or retried import will mint.
  // A stale hit there folds new rows under a dead network's rule AND makes
  // the healing refold's stored===declared compare read the lie. Clear it
  // all; the cache is lazy and refills on first use.
  invalidateCasemappingCache();
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM networks WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM highlight_rules WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_aliases WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_themes WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM avatar_sets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM upload_history WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM network_away_state WHERE user_id = ?').run(userId);
    // Network-scoped buffers cascade with networks above, but an app-scoped row
    // (network_id NULL — the reserved system/server kinds) only cascades on
    // user delete; without this a failed-then-retried import of an archive
    // carrying one would hit the idx_buffers_key UNIQUE constraint on retry.
    db.prepare('DELETE FROM buffers WHERE user_id = ?').run(userId);
    // Same class of problem as contacts: uploader_config only cascades on user
    // delete, so without this a failed-then-retried import would leave the user
    // with two copies of every personal uploader. Scoped to 'user' — the
    // instance's own rows are not this user's to wipe.
    db.prepare("DELETE FROM uploader_config WHERE scope = 'user' AND owner_user_id = ?").run(
      userId,
    );
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
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
): Promise<ImportResult> {
  // Reads the central directory only, bounded by limits.entries.
  const { zip, entries } = await openZipEntries(zipPath, limits.entries);
  // Pauses the retention sweeper for the duration — see importInProgress.
  beginImport();
  try {
    // ---- empty-account guard — before any entry BODY is read, so an account
    // the import would refuse anyway can't make it inflate the archive. ----
    if (!accountIsEmpty(targetUserId)) {
      throw new ImportError(
        'account_not_empty',
        'target account already has data; imports require a fresh account',
      );
    }

    // ---- manifest ----
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry) {
      throw new ImportError('missing_manifest', 'archive does not contain manifest.json');
    }
    const manifest = parseJson<Record<string, unknown>>(
      await readEntryBounded(zip, manifestEntry, 'manifest.json', limits.manifestBytes),
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
      await readEntryBounded(zip, dataEntry, 'data.json', limits.jsonBytes),
      'bad_data',
      'data.json',
    );

    // ---- <section>.json: bookmarks, reactions (#992) — optional, small ----
    // Each is its table's rows, inserted in Phase C like any other table (the
    // generic path rekeys through the messages map and drops a row whose line
    // didn't make the trip). A history-less archive, or one from before a file
    // existed, simply has none. data.json never carries these tables, so this
    // doesn't overwrite anything.
    for (const [table, def] of historyFileTables()) {
      const name = `${def.section}.json`;
      const entry = entries.get(name);
      if (!entry) continue;
      data[table] = parseJson<Record<string, unknown>[]>(
        await readEntryBounded(zip, entry, name, limits.jsonBytes),
        `bad_${def.section}`,
        name,
      );
    }

    // ---- thumbnails — read up front so phase C can apply them inside a
    // synchronous transaction. Accepts .webp (since #560) and .jpg (everything
    // exported before it, which must keep importing). The extension only locates
    // the entry; the bytes go into the BLOB as-is and the serving route sniffs
    // their type, so a mismatch here can't corrupt anything. ----
    // A thumbnail is a preview, so one past its bound is skipped rather than
    // failing the import, and one that would overrun the total budget is
    // skipped while a smaller one after it may still fit.
    const thumbs = new Map<number, Buffer>();
    let thumbBytes = 0;
    for (const [name, entry] of entries) {
      const m = name.match(/^thumbnails\/(\d+)\.(?:jpg|webp)$/);
      if (!m) continue;
      if (entry.uncompressedSize > limits.thumbnailBytes) continue;
      if (thumbBytes + entry.uncompressedSize > limits.thumbnailsTotalBytes) continue;
      const buf = await readEntryBuffer(zip, entry, limits.thumbnailBytes);
      if (buf === null) continue;
      thumbBytes += buf.length;
      thumbs.set(parseInt(m[1], 10), buf);
    }
    // ---- avatar set tiles (#607), by the archive's set id. They go back
    // through the service with the rows, which re-judges every image the way
    // an upload is judged, so a crafted archive can't plant what POST
    // /api/avatar-sets would refuse. ----
    // Bounded like an upload: only sets the archive's data.json names, at
    // most the tile limit per set, each entry no larger than one image, and
    // the whole lot no more than one upload may unpack to. A crafted
    // archive's oversize entries are left in the zip unread.
    const avatarTiles = new Map<number, Array<{ name: string; data: Buffer }>>();
    const archivedSets = new Set(
      ((data.avatar_sets ?? []) as Array<Record<string, unknown>>)
        .map((row) => Number(row?.id))
        .filter((id) => Number.isInteger(id)),
    );
    let tileBytes = 0;
    for (const [name, entry] of entries) {
      const m = name.match(/^avatar_sets\/(\d+)\/(\d{3})\.webp$/);
      if (!m) continue;
      const setId = parseInt(m[1], 10);
      if (!archivedSets.has(setId)) continue;
      const list = avatarTiles.get(setId) ?? [];
      if (list.length >= AVATAR_SET_MAX_TILES) continue;
      if (entry.uncompressedSize > AVATAR_SET_IMAGE_MAX_BYTES) continue;
      if (tileBytes + entry.uncompressedSize > AVATAR_SET_UNPACKED_MAX_BYTES) break;
      const buf = await readEntryBuffer(zip, entry, AVATAR_SET_IMAGE_MAX_BYTES);
      if (!buf) continue;
      tileBytes += buf.length;
      list.push({ name: m[2], data: buf });
      avatarTiles.set(setId, list);
    }

    const counts: Record<string, number> = {};
    const idMaps: Record<string, Map<unknown, unknown>> = {};
    let thumbnailsAttached = 0;

    const avatarSetIds = new Map<unknown, unknown>();
    try {
      // ---- avatar sets (#607): through the service, ahead of Phase A, since
      // the image normaliser is async and Phase A is one synchronous
      // transaction. An invalid set drops alone; the pointer rewrite in Phase
      // A then misses and falls back to the bundled set. The wipe runs first,
      // so a retried import can't collide on the NOCASE UNIQUE name. Inside
      // the try: a failure after the first set is rolled back with the rest.
      db.prepare('DELETE FROM avatar_sets WHERE user_id = ?').run(targetUserId);
      for (const row of (data.avatar_sets ?? []) as Array<Record<string, unknown>>) {
        if (!row || typeof row !== 'object') continue;
        const oldId = Number(row.id);
        if (!Number.isInteger(oldId)) continue;
        const tiles = avatarTiles.get(oldId) ?? [];
        let result = await avatarSetsService.createFromImages(targetUserId, row.name, tiles);
        // An upload could be named Plain or Initial until those became the
        // bundled sets' own names. It comes back under a name that says so
        // rather than not at all.
        if (
          !result.ok &&
          typeof row.name === 'string' &&
          ['plain', 'initial'].includes(row.name.trim().toLowerCase())
        ) {
          result = await avatarSetsService.createFromImages(
            targetUserId,
            `${row.name.trim()} (uploaded)`,
            tiles,
          );
        }
        if (result.ok) avatarSetIds.set(row.id, result.set.id);
      }

      // ---- Phase A: data.json tables that don't depend on messages (one tx). ----
      db.transaction(() => {
        // Fresh accounts usually have an auto-synced system.timezone row; wipe
        // before insert — import replaces, doesn't merge. Same for saved
        // themes: accountIsEmpty only checks networks, so a zero-network
        // account can still hold themes whose names would collide with the
        // archive's on the NOCASE UNIQUE constraint (or silently merge).
        db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(targetUserId);
        db.prepare('DELETE FROM user_themes WHERE user_id = ?').run(targetUserId);
        // And aliases (#276), for the same reason: a name in both would fail
        // the primary key, and one in neither would merge.
        db.prepare('DELETE FROM user_aliases WHERE user_id = ?').run(targetUserId);
        // avatar_sets were wiped and re-ingested just above, outside this tx.
        for (const table of IMPORT_ORDER) {
          const def = EXPORT_TABLES[table as keyof typeof EXPORT_TABLES] as
            | ExportTableDefFull
            | undefined;
          if (!def || def.mode === 'skip') continue;
          if (def.section && def.section !== 'data') continue;
          if (dependsOnMessages(def)) continue;
          if (table === 'avatar_sets') {
            // Ingested before the transaction (the normaliser is async); the
            // sets are already in, so only the id map is needed here.
            idMaps.avatar_sets = avatarSetIds;
            counts.avatar_sets = avatarSetIds.size;
            continue;
          }
          insertTable(table, data, idMaps, counts, targetUserId);
        }
      })();

      // ---- Phase B: messages.ndjson (batched, yielding). ----
      idMaps.messages = new Map();
      const messagesEntry = entries.get('messages.ndjson');
      counts.messages = messagesEntry
        ? await streamMessagesInBatches(
            zip,
            messagesEntry,
            targetUserId,
            idMaps,
            limits.ndjsonLineBytes,
          )
        : 0;

      // ---- Phase C: the tables that hang off messages — bookmarks, reactions,
      // buffer_reads — then thumbnails (one tx). ----
      db.transaction(() => {
        for (const table of IMPORT_ORDER) {
          const def = EXPORT_TABLES[table as keyof typeof EXPORT_TABLES] as
            | ExportTableDefFull
            | undefined;
          if (!def || def.mode === 'skip') continue;
          if (def.section === 'messages') continue;
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

        // Legacy archives (pre-buffers-registry) carry channels + closed_buffers
        // instead of a buffers table; synthesize the registry the same way the
        // schema-16 migration backfills a live DB. Runs after the messages
        // stream because buffer existence in those archives IS the message
        // history. Modern archives skip this (their buffers table imported in
        // Phase A).
        convertLegacyBuffers(data, idMaps, counts, targetUserId);

        // An archive taken before #666 carries a live `chat.smart_filter` row,
        // which the boot migration has already retired everywhere else — so
        // importing one reintroduces a key nothing reads, and the user's smart
        // filtering silently reverts to "show everything" until the next restart
        // happens to re-run it. Idempotent and self-terminating, so calling it
        // here just converts whatever this import brought in.
        migrateSmartFilterToEventMode(db);
      })();
    } catch (err) {
      resetImportedData(targetUserId);
      if (err instanceof ImportError) throw err;
      throw new ImportError('insert_failed', `import failed: ${(err as Error).message}`);
    }

    // The message stream above bypasses insertMessage, so nothing marked the
    // imported buffers for the retention sweeper — without this, an over-cap
    // archive sits unexamined until the next restart or a live line lands in
    // each buffer. The noise-clock cursor needs the matching treatment:
    // imported noise can be older than the account's low-water mark, and the
    // insert-side rewind never saw it — forget the cursor so the next pass
    // walks from the beginning.
    seedAllBuffersDirty();
    clearNoiseCursorForUser(targetUserId);
    // Imported buffer_retention rows arrive through the generic table copy,
    // which enforces no value constraints — clamp them into the registry
    // knob's validity hole (0 or >= minNonzero, <= max) by DROPPING invalid
    // rows back to "inherit" rather than letting a crafted archive plant a
    // 1-line cap the UI could never have written.
    {
      const opt = getOption('data.retention.lines');
      if (opt?.type === 'int' && typeof opt.max === 'number') {
        db.prepare(
          `DELETE FROM buffer_retention
            WHERE user_id = ? AND (max_lines > ? OR (max_lines <> 0 AND max_lines < ?))`,
        ).run(targetUserId, opt.max, opt.minNonzero ?? 0);
      }
    }

    return { manifest, counts, thumbnailsAttached };
  } finally {
    endImport();
    zip.close();
  }
}

// Back-compat entrypoint: accepts an in-memory buffer (used by tests and any
// caller that already has the bytes). Spills to a temp file and delegates to
// the streaming path so there's a single import implementation.
export async function importFromZipBuffer(
  targetUserId: number,
  zipBuffer: Buffer,
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
): Promise<ImportResult> {
  const tmp = path.join(os.tmpdir(), `lurker-import-${randomBytes(8).toString('hex')}.lurk`);
  // 0600 — the archive carries decrypted network passwords; don't leave it
  // world-readable under a permissive umask.
  await fs.promises.writeFile(tmp, zipBuffer, { mode: 0o600 });
  try {
    return await importFromZipFile(targetUserId, tmp, limits);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}
