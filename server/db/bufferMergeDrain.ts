// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { BUFFER_SCOPED_TABLES } from './bufferKeyedTables.js';
import { markBufferDirty } from './retention.js';

// Moving a merged buffer's history, a chunk at a time (#1307).
//
// A merge repoints every message of the absorbed buffer at the survivor. As
// one statement that held the event loop for as long as the buffer was big
// (128k rows: 1.7 s on warm NVMe), rewriting each row, every index led by
// buffer_id, and the row's entry in the search index. Nothing else is served
// meanwhile.
//
// So the merge moves the NEWEST chunk inside its own transaction and, when
// that empties the absorbed buffer, deletes the row there and then: a merge
// that fits in one chunk is exactly the merge it always was. When rows are
// left, the absorbed row stays behind as a DRAINING row and the rest follow
// here, newest first, one transaction per chunk, the loop given back between
// chunks.
//
// A draining row (buffers.merged_into IS NOT NULL) is not a buffer to anyone
// but this module and the foreign key its messages hold:
//   - its name is vacated (target_folded is a string no fold produces), so no
//     lookup by name finds it and the survivor is free to take the name;
//   - the registry's listings and the lookup by id leave it out;
//   - it holds no satellite state: what the survivor did not adopt is deleted
//     with the merge, as the cascade would have deleted it;
//   - `target` keeps the name it had, which is what a search hit on a row not
//     yet moved is shown under.
//
// Newest first is what keeps the window small for a reader. Clients answer a
// merge by fetching the survivor's latest page again, and that page is whole
// after the first chunk; so are the read pointer and the counts above it.
// What is short for the seconds a drain takes is the survivor's OLDER
// history: a page far back, or a search inside it. Nothing is lost.
//
// Each chunk is "move the newest N that are left", which holds no cursor and
// can be given again after a kill: boot calls kickMergeDrain and it goes on
// from wherever the last committed chunk stopped.

/** Rows moved per transaction. Measured on a 3M-row database, warm NVMe,
 *  moving 128,631 rows: 1,000 is 25 ms a chunk (p95 31, worst 44) and 2.9 s
 *  in all, against 2.6 s for the one statement that held the loop throughout.
 *  2,000 halves the chunk count for 41 ms a chunk; 500 gains little. Slow
 *  storage multiplies these, and has a long way to go to the event loop
 *  monitor's 500 ms. */
export const MERGE_CHUNK_ROWS = 1_000;

/** A caller's chunk size, as a whole number of rows of at least one. */
export function mergeChunkRows(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return MERGE_CHUNK_ROWS;
  return Math.max(1, Math.floor(requested));
}

// The inner SELECT is the head of one run of idx_messages_buf_unread
// (buffer_id, id DESC), read out before the first row is written. Exported
// for the plan test.
export const MOVE_CHUNK_SQL = `
  UPDATE messages SET buffer_id = ? WHERE id IN (
    SELECT id FROM messages WHERE buffer_id = ? ORDER BY id DESC LIMIT ?
  )
`;
const moveChunkStmt = db.prepare(MOVE_CHUNK_SQL);
const hasRowsStmt = db.prepare(`SELECT 1 FROM messages WHERE buffer_id = ? LIMIT 1`);

/** Move up to `chunkRows` of `absorbedId`'s newest messages to `survivorId`.
 *  Returns how many moved. Runs inside the caller's transaction. */
export function moveMessageChunk(
  survivorId: number,
  absorbedId: number,
  chunkRows: number,
): number {
  return moveChunkStmt.run(survivorId, absorbedId, chunkRows).changes;
}

export function bufferHasMessages(bufferId: number): boolean {
  return hasRowsStmt.get(bufferId) !== undefined;
}

// The name a draining row is filed under. NUL cannot occur in an IRC name or
// in one of our ':'-sentinels, and the id keeps the unique index satisfied.
const drainingFold = (bufferId: number) => `\u0000merging:${bufferId}`;

// Closed with no closed_at is the registry's "never surfaced" shape, which
// closed-buffer GC does not collect. autojoin and key were unioned into the
// survivor before this runs.
const hideStmt = db.prepare(`
  UPDATE buffers
     SET merged_into = ?, target_folded = ?, state = 'closed', closed_at = NULL,
         autojoin = 0, key = NULL
   WHERE id = ?
`);
// A buffer still draining INTO the one being absorbed drains into its
// survivor instead: nothing may point at a row that is itself going away.
const repointDrainingStmt = db.prepare(`UPDATE buffers SET merged_into = ? WHERE merged_into = ?`);

// Every buffer_id-keyed table but messages. From the registry, which a test
// holds to the live schema, so a table added later is covered here too.
const satelliteDeletes = BUFFER_SCOPED_TABLES.filter(
  (t) => t.status === 'buffer_id' && t.table !== 'messages',
).map((t) => db.prepare(`DELETE FROM ${t.table} WHERE buffer_id = ?`));

/** A buffer that was draining into `absorbedId` now drains into `survivorId`.
 *  Called by a merge before it moves anything. */
export function repointDraining(survivorId: number, absorbedId: number): void {
  repointDrainingStmt.run(survivorId, absorbedId);
}

/** Leave `absorbedId` behind as a draining row of `survivorId`: it still has
 *  messages, and they follow in the background. Runs inside the merge's
 *  transaction, after the survivor has adopted what it adopts. */
export function leaveDraining(survivorId: number, absorbedId: number): void {
  for (const stmt of satelliteDeletes) stmt.run(absorbedId);
  hideStmt.run(survivorId, drainingFold(absorbedId), absorbedId);
}

const nextDrainingStmt = db.prepare(`
  SELECT id, merged_into AS survivorId FROM buffers
   WHERE merged_into IS NOT NULL ORDER BY id LIMIT 1
`);
// Only an empty row goes: the delete cascades to messages, and a row that
// reached this buffer by its id since the chunk was read must not go with it.
const deleteDrainedStmt = db.prepare(`
  DELETE FROM buffers
   WHERE id = ? AND merged_into IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM messages WHERE buffer_id = buffers.id)
`);

const drainChunkTx = db.transaction((chunkRows: number): boolean => {
  const next = nextDrainingStmt.get() as { id: number; survivorId: number } | undefined;
  if (!next) return false;
  const moved = moveChunkStmt.run(next.survivorId, next.id, chunkRows).changes;
  if (moved < chunkRows && deleteDrainedStmt.run(next.id).changes > 0) {
    // The survivor's line cap now counts the whole merged history.
    markBufferDirty(next.survivorId);
  }
  return true;
});

/**
 * Move one chunk for the oldest draining buffer, deleting its row once it is
 * empty. Returns false when there is nothing draining. One IMMEDIATE
 * transaction: it reads before it writes (the Litestream SQLITE_BUSY_SNAPSHOT
 * shape, db/index.ts).
 */
export function drainMergeChunk(chunkRows?: number): boolean {
  return drainChunkTx.immediate(mergeChunkRows(chunkRows));
}

/** Drain everything, without giving the loop back. For tools and tests; the
 *  server uses kickMergeDrain. */
export function drainMergesNow(chunkRows?: number): void {
  while (drainMergeChunk(chunkRows)) {
    /* next chunk */
  }
}

const RETRY_MS = 5_000;
let running = false;

/**
 * Start the background drain if it is not running: one chunk, then the event
 * loop, then the next, until no buffer is draining. Called after a merge that
 * left one, and at boot for a drain a restart interrupted. A chunk that
 * throws (a write lock held past the busy timeout) is tried again later;
 * every chunk committed before it stays moved.
 */
export function kickMergeDrain(chunkRows?: number): void {
  if (running) return;
  running = true;
  const step = () => {
    let more: boolean;
    try {
      more = drainMergeChunk(chunkRows);
    } catch (e) {
      console.warn('[merge] drain chunk failed, will retry:', (e as Error)?.message || e);
      setTimeout(step, RETRY_MS).unref();
      return;
    }
    if (more) setImmediate(step);
    else running = false;
  };
  setImmediate(step);
}
