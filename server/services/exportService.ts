// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-user data export. Streams a zip to a writable destination (a file on
// disk, written by the background export worker — or, in tests, a PassThrough).
// Driven entirely by EXPORT_TABLES — if a table is declared as exported there,
// it lands in the zip; if it's declared as skipped, it doesn't. The schema
// tripwire in exportSchema.test.js guarantees the registry covers every live
// table.
//
// IMPORTANT: this module is connection-agnostic — every function takes the
// `better-sqlite3` connection to read from as its first argument and this file
// deliberately does NOT import the db singleton (`db/index.ts`). That keeps it
// safe to import inside a worker thread, which opens its OWN readonly
// connection to the same WAL file. Holding a streaming `.iterate()` cursor open
// on the *shared* connection while the IRC bouncer writes is what crashed the
// process before (better-sqlite3 throws "database connection is busy"); a
// separate reader connection makes that collision structurally impossible.

import type { Writable } from 'stream';
import { Readable } from 'stream';
import type { Database } from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import { EXPORT_TABLES, EXPORT_FORMAT_VERSION } from '../db/exportSchema.js';
import { extensionFor, thumbnailMime } from './imagePipeline.js';
import { decryptSecret } from '../utils/secretCrypto.js';

interface ExportTableDefWithScope {
  scope: string;
  columns: string[];
  mode: string;
  section?: string;
  pk?: string;
  blobColumns?: string[];
  encryptedColumns?: string[];
  rekeyOnImport?: boolean;
  fkRekey?: Record<string, string>;
}

/** Called periodically as messages stream out so the job row + WS can report progress. */
export type ExportProgressFn = (processed: number, total: number) => void;

// SQL fragment that filters a table to a single user's rows. Returned as
// `{ where, params }` so callers can splice it into a SELECT.
function scopeFilter(scope: string, userId: number): { where: string; params: number[] } {
  switch (scope) {
    case 'identity':
      return { where: 'WHERE id = ?', params: [userId] };
    case 'user_id':
      return { where: 'WHERE user_id = ?', params: [userId] };
    case 'via_network':
      return {
        where: 'WHERE network_id IN (SELECT id FROM networks WHERE user_id = ?)',
        params: [userId],
      };
    case 'via_rules':
      return {
        where: 'WHERE rule_id IN (SELECT id FROM highlight_rules WHERE user_id = ?)',
        params: [userId],
      };
    // uploader_config (#514): a user's OWN uploaders only. The scope='user' half
    // is load-bearing, not decoration — without it an export would rake in the
    // instance's x0/catbox/local rows (owner_user_id IS NULL, so they'd slip a
    // `WHERE owner_user_id = ?` only by luck) and hand the operator's
    // configuration to whoever asked for their data.
    case 'owned_uploaders':
      return { where: "WHERE scope = 'user' AND owner_user_id = ?", params: [userId] };
    default:
      throw new Error(`exportService: unknown scope "${scope}"`);
  }
}

function countRows(db: Database, table: string, scope: string, userId: number): number {
  const { where, params } = scopeFilter(scope, userId);
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params) as { n: number })
    .n;
}

// Project a row into the shape that lands in the export. Strips BLOB columns
// (they get written to thumbnails/<id>.<ext> separately) and replaces them
// with a hasThumbnail flag so the importer knows to look for the file.
function projectRow(
  row: Record<string, unknown>,
  def: ExportTableDefWithScope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of def.columns) {
    if (def.blobColumns?.includes(col)) continue;
    out[col] = row[col];
  }
  if (def.blobColumns?.includes('thumbnail')) {
    out.hasThumbnail = row.thumbnail != null;
  }
  return out;
}

// Rows read (and progress reported) per page. Big enough that per-page query
// overhead is negligible, small enough that the synchronous chunk between
// event-loop yields stays short.
const MESSAGE_PAGE = 2000;

// Stream a user's messages as NDJSON, paginated by id (keyset), yielding to the
// event loop between pages.
//
// This is the heart of the lurker#175 fix. Each page is a discrete `.all()`
// that runs to completion and releases its statement BEFORE we await — we never
// hold an `.iterate()` cursor open across a yield. So even though the export
// reads on the same shared better-sqlite3 connection the IRC bouncer writes on,
// a concurrent insert landing between pages can't trip "this database
// connection is busy executing a query" (the crash that took the process down).
// The per-page `setImmediate` also keeps the loop responsive on a large export.
async function* messagesNdjsonGenerator(
  db: Database,
  userId: number,
  total: number,
  onProgress?: ExportProgressFn,
): AsyncGenerator<string> {
  const def = EXPORT_TABLES.messages as ExportTableDefWithScope;
  const { where, params } = scopeFilter(def.scope, userId);
  const cols = def.columns.join(', ');
  const pageStmt = db.prepare(
    `SELECT ${cols} FROM messages ${where} AND id > ? ORDER BY id ASC LIMIT ${MESSAGE_PAGE}`,
  );
  let lastId = 0;
  let processed = 0;
  for (;;) {
    const rows = pageStmt.all(...params, lastId) as Array<Record<string, unknown> & { id: number }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      lastId = row.id;
      processed += 1;
      yield JSON.stringify(projectRow(row, def)) + '\n';
    }
    // `total` is a COUNT(*) taken before the walk; a write committing mid-export
    // can push the actual row count past it, so report max(total, processed) to
    // keep the denominator from trailing the numerator.
    if (onProgress) onProgress(processed, Math.max(total, processed));
    // Hand the loop back between pages; the next page resumes at id > lastId.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (onProgress) onProgress(processed, Math.max(total, processed));
}

function selectAll(
  db: Database,
  table: string,
  def: ExportTableDefWithScope,
  userId: number,
): Record<string, unknown>[] {
  const { where, params } = scopeFilter(def.scope, userId);
  const cols = def.columns.join(', ');
  const order = def.pk ? `ORDER BY ${def.pk} ASC` : '';
  return db.prepare(`SELECT ${cols} FROM ${table} ${where} ${order}`).all(...params) as Record<
    string,
    unknown
  >[];
}

export function computeExportPreview(
  db: Database,
  userId: number,
  { includeMessages = false } = {},
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, def] of Object.entries(EXPORT_TABLES)) {
    const d = def as ExportTableDefWithScope;
    if (d.mode !== 'export' && d.mode !== 'partial') continue;
    if (d.section === 'messages' && !includeMessages) {
      counts[table] = 0;
      continue;
    }
    if (d.section === 'bookmarks' && !includeMessages) {
      counts[table] = 0;
      continue;
    }
    counts[table] = countRows(db, table, d.scope, userId);
  }
  return counts;
}

/** Total messages a with-history export will write for `userId` (the progress denominator). */
export function countExportMessages(db: Database, userId: number): number {
  return countRows(
    db,
    'messages',
    (EXPORT_TABLES.messages as ExportTableDefWithScope).scope,
    userId,
  );
}

function getSchemaVersion(db: Database): number {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? parseInt(row.value, 10) || 0 : 0;
}

// Build the export zip and stream it to `destStream`. Resolves when the
// archive has been finalized (every byte is in destStream's buffer or
// further downstream). Rejects if archiver emits an error.
//
// `db` is the connection to read from — the shared singleton in production
// (the paged message stream above keeps that safe under concurrent writes).
// The caller owns Content-Type / Content-Disposition (when piping to an HTTP
// response); we don't set them here so the function stays reusable from the
// job runner (piping to a file) and tests (piping to a stream).
export async function buildExportZip(
  db: Database,
  userId: number,
  { includeMessages = false } = {},
  destStream: Writable,
  onProgress?: ExportProgressFn,
): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const archiveDone = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    archive.on('warning', (err) => {
      // ENOENT warnings from archiver are non-fatal but we surface anything else.
      if (err.code !== 'ENOENT') reject(err);
    });
    destStream.on('error', reject);
    destStream.on('finish', resolve);
    destStream.on('close', resolve);
  });

  archive.pipe(destStream);

  const sections: string[] = ['data'];
  const counts: Record<string, number> = {};

  // ---- data.json: everything except messages, bookmarks. ----
  const data: Record<string, unknown[]> = {};
  for (const [table, def] of Object.entries(EXPORT_TABLES)) {
    const d = def as ExportTableDefWithScope;
    if (d.mode !== 'export' && d.mode !== 'partial') continue;
    if (d.section && d.section !== 'data') continue;
    const rows = selectAll(db, table, d, userId);
    // Secrets encrypted at rest on hosted cells (network passwords, +k channel
    // keys) decrypt to portable plaintext so the export is restorable on a
    // self-host without the key — same content the user sees in the app. No-op
    // on a self-host (values are already plaintext). Which columns is declared
    // per-table via `encryptedColumns` in exportSchema.ts.
    if (d.encryptedColumns) {
      for (const row of rows) {
        for (const col of d.encryptedColumns) {
          row[col] = decryptSecret(row[col] as string | null);
        }
      }
    }
    data[table] = rows.map((row) => projectRow(row, d));
    counts[table] = rows.length;

    // Thumbnails — emit each blob as a separate zip entry. The extension is
    // sniffed from the bytes, not assumed: thumbnails are WebP since #560 but a
    // long-lived account still has JPEG ones from before, so a single archive can
    // legitimately hold both.
    if (d.blobColumns?.includes('thumbnail')) {
      for (const row of rows) {
        if (row.thumbnail != null) {
          const blob = row.thumbnail as Buffer;
          const ext = extensionFor(thumbnailMime(blob), 'jpg');
          archive.append(blob, { name: `thumbnails/${row.id as number}.${ext}` });
        }
      }
    }
  }

  // ---- messages.ndjson ----
  if (includeMessages) {
    sections.push('messages');
    // COUNT(*) up front gives the progress denominator and the manifest count;
    // it's cheap on the indexed selection and known before the stream drains.
    const total = countExportMessages(db, userId);
    counts.messages = total;
    const messagesStream = Readable.from(messagesNdjsonGenerator(db, userId, total, onProgress), {
      encoding: 'utf8',
    });
    archive.append(messagesStream, { name: 'messages.ndjson' });

    // ---- bookmarks.json ----
    sections.push('bookmarks');
    const bookmarksDef = EXPORT_TABLES.user_bookmarks as ExportTableDefWithScope;
    const bookmarkRows = selectAll(db, 'user_bookmarks', bookmarksDef, userId).map((row) =>
      projectRow(row, bookmarksDef),
    );
    archive.append(JSON.stringify(bookmarkRows, null, 2), { name: 'bookmarks.json' });
    counts.user_bookmarks = bookmarkRows.length;
  } else {
    counts.messages = 0;
    counts.user_bookmarks = 0;
  }

  archive.append(JSON.stringify(data, null, 2), { name: 'data.json' });

  // ---- manifest.json ----
  const manifest = {
    export_format_version: EXPORT_FORMAT_VERSION,
    db_schema_version: getSchemaVersion(db),
    exported_at: new Date().toISOString(),
    source_user_id: userId,
    sections,
    counts,
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  await archive.finalize();
  await archiveDone;
}

// The `.lurk` extension is just a renamed zip — yauzl reads it fine by
// content, not extension. The custom suffix sidesteps Safari's
// auto-unarchive-on-download behavior (which fires for application/zip)
// and labels the file as obviously a Lurker export.
export function buildExportFilename(username: string, { includeMessages = false } = {}): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safe = String(username || 'user').replace(/[^a-zA-Z0-9_-]/g, '_');
  const suffix = includeMessages ? '' : '-settings';
  return `lurker-export-${safe}-${date}${suffix}.lurk`;
}
