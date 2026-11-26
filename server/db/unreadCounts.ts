// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The stored unread count (#1436). The triggers in db/index.ts keep each
// buffer's count through every insert, delete and move; this module is the
// rest: reading it, moving it when the read pointer advances, and building it
// for a buffer that has none.
//
// Every statement here walks a bounded number of rows (UNREAD_WALK_ROWS). A
// buffer whose unread range is longer than that is counted across ticks by the
// fill (services/unreadFiller.ts), which keeps its place in the row itself
// (`unread_fill_id`) so a restart resumes it and the triggers stay exact
// behind it: a row at or below the fill's place is counted and kept by the
// triggers, one above it is still to be walked.

import db from './index.js';
import { countableSql, hiddenReplySql, serverBufferSql } from './unreadRule.js';

/** Rows one statement may walk: the size of one fill chunk, and how far a read
 *  or a mark-read looks before leaving the buffer to the fill. */
export const UNREAD_WALK_ROWS = 2000;

export interface UnreadCount {
  /** Countable rows past the read pointer. */
  count: number;
  /** Of those, the replies `chat.threads` hides from the channel. */
  replies: number;
}

interface CounterRow {
  server: number;
  userId: number;
  afterId: number;
  count: number | null;
  replies: number;
  fillId: number | null;
}

const rowStmt = db.prepare(`
  SELECT ${serverBufferSql('')} AS server, user_id AS userId,
         unread_after_id AS afterId, unread_count AS count,
         unread_replies AS replies, unread_fill_id AS fillId
    FROM buffers WHERE id = ?
`);

// The pointer as buffer_reads holds it. A fill counts from here, not from
// whatever a reader asked about: a reader can hold a pointer a tick old.
const pointerStmt = db.prepare(`
  SELECT last_read_message_id AS id FROM buffer_reads WHERE user_id = ? AND buffer_id = ?
`);

// One window of a buffer in id order: how many rows it walked, how many of
// them count, and where it stopped. The LIMIT is on rows WALKED (membership
// noise included), so a statement's cost is fixed however little of a buffer
// counts. Rides idx_messages_buf_unread; only a countable row is fetched from
// the table, for the reply columns (CASE, so the others never are).
const walkSql = (server: boolean) => {
  const countable = countableSql('', server ? '1' : '0');
  return `
  SELECT COUNT(*) AS walked, COALESCE(SUM(c), 0) AS n, COALESCE(SUM(r), 0) AS r,
         MAX(id) AS lastId
    FROM (
      SELECT id, ${countable} AS c,
             CASE WHEN ${countable} THEN ${hiddenReplySql('')} ELSE 0 END AS r
        FROM messages
       WHERE buffer_id = @bufferId AND id > @after AND id <= @upTo
       ORDER BY id ASC
       LIMIT @limit
    )`;
};
export const UNREAD_WALK_SQL = walkSql(false);
const walkStmts = { channel: db.prepare(UNREAD_WALK_SQL), server: db.prepare(walkSql(true)) };

interface Walk {
  walked: number;
  n: number;
  r: number;
  lastId: number | null;
}

let walkRows = UNREAD_WALK_ROWS;

/** Tests only: a walk size small enough that a few rows are a deep buffer. */
export function setUnreadWalkRowsForTests(rows: number | null): void {
  walkRows = rows ?? UNREAD_WALK_ROWS;
}

function walk(row: CounterRow, bufferId: number, after: number, upTo: number): Walk {
  const stmt = row.server ? walkStmts.server : walkStmts.channel;
  return stmt.get({ bufferId, after, upTo, limit: walkRows }) as Walk;
}

/** Whether a walk reached the end of its range (and so counted all of it). */
const complete = (w: Walk) => w.walked < walkRows;

const storeStmt = db.prepare(`
  UPDATE buffers
     SET unread_after_id = @afterId, unread_count = @count, unread_replies = @replies,
         unread_fill_id = @fillId
   WHERE id = @bufferId
`);

function store(bufferId: number, afterId: number, count: number, replies: number): UnreadCount {
  storeStmt.run({ bufferId, afterId, count, replies, fillId: null });
  return { count, replies };
}

const known = (row: CounterRow) => row.count !== null && row.fillId === null;

// ─── The fill queue ────────────────────────────────────────────────────────
//
// Buffers whose count is being built. In memory, like retention's dirty set:
// the row's `unread_fill_id` is the durable half, and listFillingBuffers
// re-seeds this at boot.

const fillQueue = new Set<number>();
let wakeFiller: () => void = () => {};

/** The filler's hook: called when a buffer joins an empty queue. */
export function setUnreadFillWaker(fn: () => void): void {
  wakeFiller = fn;
}

function queueFill(bufferId: number): void {
  const wasEmpty = fillQueue.size === 0;
  fillQueue.add(bufferId);
  if (wasEmpty) wakeFiller();
}

/** The next buffer to fill, or undefined when there is none. */
export function nextFillBuffer(): number | undefined {
  for (const id of fillQueue) return id;
  return undefined;
}

/** Every buffer a fill was under way on — boot seeding. */
export function queueInterruptedFills(): number {
  const rows = db.prepare(`SELECT id FROM buffers WHERE unread_fill_id IS NOT NULL`).all() as {
    id: number;
  }[];
  for (const { id } of rows) fillQueue.add(id);
  return rows.length;
}

/** Give up on a buffer's fill for now; the next read of it queues it again. */
export function dropUnreadFill(bufferId: number): void {
  fillQueue.delete(bufferId);
}

/** Tests only. */
export function resetUnreadFillQueueForTests(): void {
  fillQueue.clear();
}

// Start counting a buffer from `afterId` in chunks: an empty count whose place
// is the pointer itself, so the triggers apply nothing until the walk has
// passed a row.
function beginFill(bufferId: number, afterId: number): void {
  storeStmt.run({ bufferId, afterId, count: 0, replies: 0, fillId: afterId });
  queueFill(bufferId);
}

/**
 * One chunk of a buffer's fill. Returns 'more' while there is range left,
 * 'done' when the count just became whole, and 'idle' when there was nothing
 * to do (the buffer is gone, or a mark-read counted it in the meantime).
 */
export function fillUnreadStep(bufferId: number): 'more' | 'done' | 'idle' {
  const row = rowStmt.get(bufferId) as CounterRow | undefined;
  if (!row || row.fillId === null || row.count === null) {
    fillQueue.delete(bufferId);
    return 'idle';
  }
  const w = walk(row, bufferId, row.fillId, Number.MAX_SAFE_INTEGER);
  const done = complete(w);
  storeStmt.run({
    bufferId,
    afterId: row.afterId,
    count: row.count + w.n,
    replies: row.replies + w.r,
    fillId: done ? null : w.lastId,
  });
  if (done) fillQueue.delete(bufferId);
  return done ? 'done' : 'more';
}

// ─── Reading ───────────────────────────────────────────────────────────────

/**
 * The buffer's unread count past `afterId`, or null when it isn't known yet.
 *
 * Known means a stored count for this same pointer, or a range short enough to
 * count here and now (and that is then stored). On null the buffer is left
 * with the fill, which counts from the stored pointer; the caller shows the
 * capped walk until `onFilled` says the count is whole.
 */
export function readUnreadCount(bufferId: number, afterId: number): UnreadCount | null {
  const row = rowStmt.get(bufferId) as CounterRow | undefined;
  if (!row) return null;
  if (known(row) && row.afterId === afterId) {
    return { count: row.count as number, replies: row.replies };
  }
  if (row.fillId !== null) {
    queueFill(bufferId);
    return null;
  }
  const w = walk(row, bufferId, afterId, Number.MAX_SAFE_INTEGER);
  if (complete(w)) return store(bufferId, afterId, w.n, w.r);
  // Too long to count here. Whether there is anything to build depends on the
  // real pointer: a caller a tick behind it must not throw away a count that
  // is right.
  const pointer = (pointerStmt.get(row.userId, bufferId) as { id: number } | undefined)?.id ?? 0;
  if (!(known(row) && row.afterId === pointer)) beginFill(bufferId, pointer);
  return null;
}

// ─── The pointer moved ─────────────────────────────────────────────────────

/**
 * Carry the count to a read pointer that just advanced to `afterId`. Called by
 * setReadState, the one writer of the pointer that knows about the count.
 *
 * Three bounded tries, cheapest for the common case first: what is left past
 * the new pointer (nothing, when the buffer was read to its end), then what
 * the pointer moved over (little, when a deep buffer is read a screen at a
 * time). A deep buffer takes the second first. Neither fitting, the fill
 * counts it — carrying on from where it is, when one is already under way and
 * the pointer is still behind it.
 */
export function advanceUnreadCount(bufferId: number, afterId: number): void {
  const row = rowStmt.get(bufferId) as CounterRow | undefined;
  if (!row) return;
  if (row.count !== null && row.afterId === afterId) return;

  const movedOver = (): boolean => {
    if (!known(row) || row.afterId >= afterId) return false;
    const w = walk(row, bufferId, row.afterId, afterId);
    if (!complete(w)) return false;
    // Never below zero: a count that drifted is corrected, not carried negative.
    store(
      bufferId,
      afterId,
      Math.max(0, (row.count as number) - w.n),
      Math.max(0, row.replies - w.r),
    );
    return true;
  };

  // A fill is under way and the pointer moved inside the part it has walked:
  // take what it moved over off the part-built count and let the fill carry
  // on, rather than start a long walk again for every screen read meanwhile.
  const movedOverMidFill = (): boolean => {
    if (row.count === null || row.fillId === null) return false;
    if (row.afterId >= afterId || afterId > row.fillId) return false;
    const w = walk(row, bufferId, row.afterId, afterId);
    if (!complete(w)) return false;
    storeStmt.run({
      bufferId,
      afterId,
      count: Math.max(0, row.count - w.n),
      replies: Math.max(0, row.replies - w.r),
      fillId: row.fillId,
    });
    queueFill(bufferId);
    return true;
  };

  const deep = known(row) && (row.count as number) >= walkRows;
  if (deep && movedOver()) return;
  const left = walk(row, bufferId, afterId, Number.MAX_SAFE_INTEGER);
  if (complete(left)) {
    store(bufferId, afterId, left.n, left.r);
    return;
  }
  if (!deep && movedOver()) return;
  if (movedOverMidFill()) return;
  beginFill(bufferId, afterId);
}
