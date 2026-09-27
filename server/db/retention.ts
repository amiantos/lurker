// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Storage side of history retention (lurker-dev/RETENTION_PLAN.md): the dirty-buffer set
// that tells the sweeper where to look, and the statements it runs. The
// scheduling lives in services/retentionSweeper.ts; this module owns the SQL
// so the statements sit next to the schema they depend on.
//
// The walks ride idx_messages_buf_unread (buffer_id, id DESC, …) — reply
// threads add seeks on the reply and msgid indexes — and count-based
// retention needs no new index, which is half the reason it won
// over age-based (the other half is in the plan). The messages_ad trigger
// keeps messages_fts in sync through these deletes, so search never sees a
// pruned row.

import db, { EARLY_PRUNE_TYPES_SQL } from './index.js';
import { REPLY_LINE_TYPES_SQL } from '../../shared/replies.js';

// Buffers that took an insert since the sweeper last looked. In-memory on
// purpose: a restart just means the next boot seeds every buffer dirty and
// re-verifies, which is also what makes the steady sweeper double as the
// backfill when retention is first enabled on an existing database.
const dirtyBuffers = new Set<number>();

export function markBufferDirty(bufferId: number): void {
  dirtyBuffers.add(bufferId);
}

/** Drain the dirty set. The caller owns the snapshot; new inserts during a
 *  sweep land in a fresh set and are picked up next tick. */
export function takeDirtyBuffers(): number[] {
  const out = [...dirtyBuffers];
  dirtyBuffers.clear();
  return out;
}

/** Boot seeding: every buffer is suspect until the sweeper has looked once.
 *  Also the after-import catch-all — imported rows bypass insertMessage, so
 *  nothing else would ever mark their buffers. */
export function seedAllBuffersDirty(): void {
  const rows = db.prepare(`SELECT id FROM buffers`).all() as Array<{ id: number }>;
  for (const row of rows) dirtyBuffers.add(row.id);
}

/** Re-examine one user's buffers — their retention setting changed. */
export function seedUserBuffersDirty(userId: number): void {
  const rows = db.prepare(`SELECT id FROM buffers WHERE user_id = ?`).all(userId) as Array<{
    id: number;
  }>;
  for (const row of rows) dirtyBuffers.add(row.id);
}

const ownerStmt = db.prepare(`SELECT user_id AS userId FROM buffers WHERE id = ?`);

/** The buffer's owning user, or undefined for a buffer deleted since it was
 *  marked dirty (the cascade already took its messages with it). */
export function bufferOwnerId(bufferId: number): number | undefined {
  const row = ownerStmt.get(bufferId) as { userId: number } | undefined;
  return row?.userId;
}

// The newest `capLines`-th row's id: everything strictly below it is over the
// cap. OFFSET walks the buffer's own rows inside the covering index — message
// ids are a single global sequence, so id arithmetic can never answer this
// (see hasMoreThan in db/messages.ts). No row at that offset = the buffer is
// within its cap. `below` continues a walk from an earlier one (the reply
// threads' ceiling, below).
const offsetStmt = db.prepare(`
  SELECT id FROM messages WHERE buffer_id = ? AND id < ? ORDER BY id DESC LIMIT 1 OFFSET ?
`);

function rowAtOffset(bufferId: number, below: number, offset: number): number | undefined {
  const row = offsetStmt.get(bufferId, below, offset) as { id: number } | undefined;
  return row?.id;
}

export function retentionBoundaryId(bufferId: number, capLines: number): number | undefined {
  return rowAtOffset(bufferId, Number.MAX_SAFE_INTEGER, capLines - 1);
}

// ─── The tail, and reply threads ───────────────────────────────────────────
//
// A reply thread (its first line and every reply naming it — see
// messages.reply_root_msgid) is kept whole until its NEWEST line ages out: a
// reply's quote (or a view of the whole thread) would otherwise show a hole
// where the question was. So a line below the boundary is spared while a thread it
// belongs to — as a reply, or as the line that started one — has a line at or
// above the boundary. A reply to an old line keeps that line, and itself,
// rather than both going a moment after it arrives (the first cut took a
// thread when its FIRST line aged out, and a /code-review found exactly that).
//
// Spared lines only reach back so far: a second boundary, the CEILING, `cap`
// lines further down, below which everything goes, oldest first, thread or
// not. A buffer therefore never keeps more than twice its cap of lines, plus
// bookmarks older than that — an always-active thread (a bridge that replies
// to everything makes one thread of a whole channel) can't hold it open-ended,
// and neither can many live threads at once. (Bookmarks count toward the
// band like any line: leaving them out would put a bookmark probe on every
// row of the O(cap) walk that finds the ceiling.)
//
// What's spared depends only on the boundary, as the rows stand — asked in
// SQL, statement by statement, never cached across the awaits between
// batches, where a new reply can land. Deleting below the boundary never
// moves it, so walk order and where a tick's budget runs out can't change
// what survives.

// Where each buffer's walk of its band has got to, kept across visits: a
// stretch of spared lines longer than one tick can walk would otherwise be
// walked from the top every tick, and nothing under it reached. In memory — a
// restart starts the walk over, which costs a walk, not correctness. Resuming
// below the rows already walked can only postpone a deletion (a thread that
// died since is caught next time round), never make a wrong one: every row is
// judged when it's reached.
// Each walk remembers the boundary it began from: resuming under the same one
// is the same walk; under a moved one, the rows between were never looked at.
const bandWalks = new Map<number, { walkFrom: number; fromBoundary: number }>();

/** State one sweeper visit to a buffer carries between batches. */
export interface RetentionVisit {
  /** Below this, everything but bookmarks goes (0: nothing is that old). */
  ceilingId: number;
  /** The boundary this walk began from. Not the visit's own when it picked
   *  up an earlier visit's walk and the boundary has moved since: rows it
   *  moved over were never looked at, so reaching the ceiling isn't the end
   *  (see restartBandWalk). */
  fromBoundary: number;
  /** The ceiling's tail is done; the band is being walked. */
  belowCeilingDone: boolean;
  /** Where the band's next window starts (exclusive). */
  walkFrom: number;
}

/** A visit to a buffer over its cap: finds the ceiling — the same O(cap)
 *  walk as the boundary, continued from it — and picks up the band's walk
 *  where the last visit left it, if that's still inside the band. */
export function newRetentionVisit(
  bufferId: number,
  boundaryId: number,
  capLines: number,
): RetentionVisit {
  const ceilingId = rowAtOffset(bufferId, boundaryId, capLines - 1) ?? 0;
  const saved = bandWalks.get(bufferId);
  const resume = !!saved && saved.walkFrom < boundaryId && saved.walkFrom > ceilingId;
  return {
    ceilingId,
    fromBoundary: resume ? saved.fromBoundary : boundaryId,
    belowCeilingDone: ceilingId === 0,
    walkFrom: resume ? saved.walkFrom : boundaryId,
  };
}

/** Start the band's walk again from `boundaryId` — a walk begun under an
 *  earlier boundary reached the ceiling, and the top wasn't walked under this
 *  one. */
export function restartBandWalk(visit: RetentionVisit, boundaryId: number): void {
  visit.walkFrom = boundaryId;
  visit.fromBoundary = boundaryId;
}

/** Forget a buffer's band walk — it was deleted, or has nothing over its cap. */
export function dropBandWalk(bufferId: number): void {
  bandWalks.delete(bufferId);
}

/** Tests only: forget every walk, as a restart would. */
export function resetBandWalksForTests(): void {
  bandWalks.clear();
}

// Below the ceiling: one bounded bite, bookmarks exempt. Deliberately no ORDER
// BY in the subselect — everything below goes eventually, so any qualifying
// rows do. The NOT EXISTS is scoped by user_id, not just message_id:
// user_bookmarks has no index on message_id alone, and a buffer has exactly
// one owner who is the only user able to bookmark its rows, so the (user_id,
// message_id) primary key answers the probe as a seek. A bookmarked row
// survives as an extra ABOVE the cap (later boundary probes walk past it and
// it never becomes deletable).
const deleteBelowStmt = db.prepare(`
  DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m
     WHERE m.buffer_id = ? AND m.id < ?
       AND NOT EXISTS (
         SELECT 1 FROM user_bookmarks ub
          WHERE ub.user_id = ? AND ub.message_id = m.id
       )
     LIMIT ?
  )
`);

// One window of the band, [@low, @walkFrom): the rows in it that may go — not
// bookmarked, and in no thread still alive at or above the boundary. A row is
// in the thread it replies in (its reply_root_msgid: a reply at or above the
// boundary, or that thread's first line stored late there by backfill), and
// in the thread it may have started (replies naming its own msgid; only a line
// of REPLY_LINE_TYPES can start one, as replyRootFor finds them). The reply
// probes are seeks on the reply-only partial index — INDEXED BY because
// nothing runs ANALYZE — and the late-first-line probe one on the msgid index.
// The window is sized in rows WALKED (see deleteRetentionBatch), so a stretch
// of spared lines costs a window, not one unbounded statement. Exported for
// the plan test, which must plan this text and not a copy.
export const BAND_DELETE_SQL = `
  DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m
     WHERE m.buffer_id = @bufferId AND m.id < @walkFrom AND m.id >= @low
       AND NOT EXISTS (
         SELECT 1 FROM user_bookmarks ub WHERE ub.user_id = @ownerId AND ub.message_id = m.id
       )
       AND NOT (m.reply_root_msgid IS NOT NULL AND (
         EXISTS (
           SELECT 1 FROM messages r INDEXED BY idx_messages_reply_root
            WHERE r.buffer_id = @bufferId AND r.reply_root_msgid = m.reply_root_msgid
              AND r.id >= @boundaryId
         )
         OR EXISTS (
           SELECT 1 FROM messages q
            WHERE q.network_id = m.network_id AND q.msgid = m.reply_root_msgid
              AND +q.buffer_id = @bufferId AND q.id >= @boundaryId
              AND q.type IN ${REPLY_LINE_TYPES_SQL}
         )
       ))
       AND NOT (m.msgid IS NOT NULL AND m.type IN ${REPLY_LINE_TYPES_SQL} AND EXISTS (
         SELECT 1 FROM messages r INDEXED BY idx_messages_reply_root
          WHERE r.buffer_id = @bufferId AND r.reply_root_msgid = m.msgid AND r.id >= @boundaryId
       ))
  )
`;
const bandDeleteStmt = db.prepare(BAND_DELETE_SQL);

/** What one call of deleteRetentionBatch did. */
export interface RetentionBatch {
  /** Rows deleted. */
  deleted: number;
  /** Nothing left to walk this visit: below the ceiling is clear, and the
   *  band has been walked down to it. */
  done: boolean;
  /** A full batch of deletes — its time says what a batch of this size
   *  costs, so the sweeper's pacing may grow or shrink on it. */
  full: boolean;
  /** A band window: `limit` rows walked, however many were spared. Slow says
   *  the size is too big, so the pacing may shrink on it — but never grow:
   *  a cheap one may have deleted nothing, and the next window that deletes
   *  a full batch would pay for it. */
  shrinkOnly?: boolean;
}

/**
 * One step of pruning a buffer, about `limit` rows' worth: rows below the
 * ceiling first, then the band between it and the boundary, one window of
 * `limit` rows walked at a time, deleting what nothing spares (see the section
 * comment). Every call makes progress, so the sweeper loops on `done`.
 */
export function deleteRetentionBatch(
  bufferId: number,
  boundaryId: number,
  ownerUserId: number,
  limit: number,
  visit: RetentionVisit,
): RetentionBatch {
  let below = 0;
  if (!visit.belowCeilingDone) {
    below = deleteBelowStmt.run(bufferId, visit.ceilingId, ownerUserId, limit).changes;
    if (below >= limit) return { deleted: below, done: false, full: true };
    visit.belowCeilingDone = true;
    // Short: that part is clear. The band waits for the next statement, so
    // one call is one statement's cost — unless this one deleted nothing:
    // then go on, or a tick whose budget the probes had spent would loop on
    // a statement that deletes nothing, every tick, forever.
    if (below > 0) return { deleted: below, done: false, full: false };
  }
  // The window's far end: `limit` rows down from where the walk is, or the
  // ceiling when fewer are left.
  const low = rowAtOffset(bufferId, visit.walkFrom, limit - 1);
  const last = low === undefined || low <= visit.ceilingId;
  const windowLow = last ? visit.ceilingId : low;
  const deleted = bandDeleteStmt.run({
    bufferId,
    walkFrom: visit.walkFrom,
    low: windowLow,
    ownerId: ownerUserId,
    boundaryId,
  }).changes;
  visit.walkFrom = windowLow;
  if (last) bandWalks.delete(bufferId);
  else bandWalks.set(bufferId, { walkFrom: windowLow, fromBoundary: visit.fromBoundary });
  return { deleted, done: last, full: false, shrinkOnly: true };
}

// ─── The noise clock ───────────────────────────────────────────────────────

/** Every account, for the per-user noise sweep. Bounded by the user count,
 *  which is small on every edition. */
export function listUserIds(): number[] {
  return (db.prepare(`SELECT id FROM users`).all() as Array<{ id: number }>).map((r) => r.id);
}

// Per-user low-water marks for the noise sweep, persisted in app_meta as one
// JSON map (userId → the cutoff ISO the last completed sweep reached). The
// cursor is what keeps the sweep O(newly-aged rows): without it every pass
// re-walks permanently-retained index entries — bookmarked noise, and the
// entire backlog of any event_hours=0 user — from the oldest entry up, per
// user, forever. Persisted (not in-memory) because that re-walk is exactly
// what a restart must not re-pay. Deliberate edge: un-bookmarking noise that
// already fell below the owner's cursor never revisits it — the line cap
// remains its only reaper. Orphaned entries for deleted users are harmless
// and tiny.
const NOISE_CURSOR_KEY = 'retention_noise_cursors';

// ONE representation: an in-memory Map hydrated from app_meta on first use,
// with every write going through persistCursors. All readers — the sweep
// AND the insert hot path — serve from the Map, so there is no second copy
// to desync and no JSON re-parse per user per pass. `maxCursorIso` is the
// hot path's early-out watermark, and it must be the LARGEST live cursor:
// only "at or above every cursor" proves a row can't be below its owner's
// cursor, whoever the owner turns out to be. (The first version used the
// minimum — a replayed row timed between two users' cursors sailed past the
// early-out and evaded the rewind; Copilot caught it.) Live inserts sit at
// ~now, above every cursor, so the common case still skips the owner lookup.
let noiseCursors: Map<number, string> | null = null;
let maxCursorIso: string | null = null;

function loadNoiseCursors(): Map<number, string> {
  if (noiseCursors !== null) return noiseCursors;
  noiseCursors = new Map();
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(NOISE_CURSOR_KEY) as
    | { value: string }
    | undefined;
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (parsed && typeof parsed === 'object') {
        // Keep only string values: a corrupted/hand-edited blob must degrade
        // to "sweep from the beginning", never to a non-string reaching a SQL
        // bind (which would throw every tick and trip the retention breaker).
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string') noiseCursors.set(Number(k), v);
        }
      }
    } catch {
      /* unparseable = never swept */
    }
  }
  recomputeMaxCursor();
  return noiseCursors;
}

function recomputeMaxCursor(): void {
  maxCursorIso = null;
  for (const v of noiseCursors?.values() ?? []) {
    if (maxCursorIso === null || v > maxCursorIso) maxCursorIso = v;
  }
}

function persistCursors(): void {
  const map = loadNoiseCursors();
  const obj: Record<string, string> = {};
  for (const [k, v] of map) obj[String(k)] = v;
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(NOISE_CURSOR_KEY, JSON.stringify(obj));
  recomputeMaxCursor();
}

/** Where this user's last completed noise sweep stopped ('' = never swept —
 *  compares below every ISO timestamp, so the first sweep walks from the
 *  beginning). */
export function getNoiseCursor(userId: number): string {
  return loadNoiseCursors().get(userId) ?? '';
}

export function setNoiseCursor(userId: number, cutoffIso: string): void {
  loadNoiseCursors().set(userId, cutoffIso);
  persistCursors();
}

/**
 * The pass-completion write, as a compare-and-advance rather than a blind
 * set: the pass's deletes only covered [fromIso, toIso), and an insert-side
 * rewind (noteNoiseInsert, below) can land DURING the pass's awaits. If the
 * cursor moved while the pass ran, blindly writing toIso would re-hide the
 * exact replayed rows the rewind exists to save — advance only when the
 * cursor is still where the pass started.
 */
export function advanceNoiseCursor(userId: number, fromIso: string, toIso: string): void {
  if (getNoiseCursor(userId) !== fromIso) return;
  setNoiseCursor(userId, toIso);
}

/** Forget a user's cursor so the next pass walks from the beginning — the
 *  data-import path, whose bulk inserts bypass insertMessage's rewind. */
export function clearNoiseCursorForUser(userId: number): void {
  const map = loadNoiseCursors();
  if (map.delete(userId)) persistCursors();
}

/**
 * Called by insertMessage for every EARLY_PRUNE_TYPES row: stored times are
 * allowed to lie in the past (server-time tags, bouncer replay), so a noise
 * row can land BELOW its owner's low-water cursor — territory the sweep
 * treats as already cleared and would otherwise never revisit, contradicting
 * the setting's "deleted once older than N hours" promise. Rewinding the
 * cursor to the row's own time puts it back in the next pass's window. The
 * ordinary live insert (time ≈ now, above every cursor) exits on the
 * watermark compare without touching the database.
 */
export function noteNoiseInsert(bufferId: number, timeIso: string): void {
  loadNoiseCursors();
  if (maxCursorIso === null || timeIso >= maxCursorIso) return;
  const ownerId = bufferOwnerId(bufferId);
  if (ownerId === undefined) return;
  const cursor = getNoiseCursor(ownerId);
  if (cursor !== '' && timeIso < cursor) setNoiseCursor(ownerId, timeIso);
}

// One bounded bite of a user's over-age noise. INDEXED BY is load-bearing
// twice over: (1) this schema never runs ANALYZE, and without the hint the
// planner drives from buffers(user_id) and walks every one of the user's
// buffers row-by-row — the exact shape the search indexes were built to kill;
// (2) SQLite refuses to prepare an INDEXED BY whose partial-index predicate
// the query no longer implies, so widening EARLY_PRUNE_TYPES without
// migrating the index fails the boot loudly instead of silently scanning.
// `time < ?` is a lexicographic compare on the stored ISO-8601 strings, the
// same ordering assumption CHATHISTORY's window queries already rely on
// (db/messages.ts loadHistoryWindow). The NOT EXISTS is the same owner-scoped
// bookmark exemption as the count sweep — and it must be here in the SELECT,
// not just "skipped at delete": an exempt row that stayed a candidate would
// make a batch of survivors read as progress forever.
const noiseDeleteStmt = db.prepare(`
  DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m INDEXED BY idx_messages_noise_time
     JOIN buffers b ON b.id = m.buffer_id
     WHERE m.type IN (${EARLY_PRUNE_TYPES_SQL})
       AND m.time >= ?
       AND m.time < ?
       AND b.user_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM user_bookmarks ub
          WHERE ub.user_id = ? AND ub.message_id = m.id
       )
     LIMIT ?
  )
`);

// ─── Closed-buffer garbage collection ──────────────────────────────────────
//
// Deleting a whole buffer is the sanctioned policy-driven EXCEPTION to
// deleteBuffer's "only when no history" contract (db/buffers.ts, the
// evict/forget guards): the operator or user chose it, per
// lurker-dev/RETENTION_PLAN.md §4.5. The rules that keep it honest — and
// every one of them is enforced IN the statements, not sampled once at
// listing time, because the drain yields to the event loop between batches
// and the world moves while it does:
//   1. Eligibility re-derives from closed_at each pass (julianday, so the
//      SQLite datetime the close path writes and the ISO imports stamp both
//      compare correctly); autojoin rows are never dead buffers; server/system
//      pseudo-buffers store their lines elsewhere.
//   2. A buffer holding ANY bookmarked message is skipped at listing, and
//      the drain itself carries the owner-scoped bookmark exemption — a
//      bookmark placed mid-drain (search reaches closed buffers by design) is
//      skipped by the remaining batches while the buffer's other rows still
//      go, and the row delete then refuses because a row remains. The
//      bookmark can never be cascaded away; the buffer survives, closed,
//      holding only its bookmarked line(s).
//   3. Every drain batch and the final row delete re-check state='closed' AND
//      the age: a buffer reopened mid-drain stops losing rows on the very next
//      batch, and a reopen-then-reclose (closed_at re-stamped to now) is no
//      longer old enough. Messages drain in budgeted batches BEFORE the row
//      goes — one cascading DELETE over a big buffer would fire the FTS
//      trigger per row synchronously on the shared connection.

// The bookmark exclusion is a bound, non-correlated subquery (materialized
// once per statement) driving from the user's bookmarks — few — rather than a
// correlated probe walking each candidate buffer's rows.
const GC_AGE = `julianday(closed_at) < julianday('now') - ?`;
const GC_BOOKMARKED_BUFFERS = `
  SELECT m.buffer_id FROM user_bookmarks ub JOIN messages m ON m.id = ub.message_id
   WHERE ub.user_id = ? AND m.buffer_id IS NOT NULL`;

const gcEligibleStmt = db.prepare(`
  SELECT id FROM buffers
   WHERE user_id = ? AND state = 'closed' AND closed_at IS NOT NULL
     AND kind NOT IN ('server', 'system') AND autojoin = 0
     AND ${GC_AGE}
     AND id NOT IN (${GC_BOOKMARKED_BUFFERS})
   LIMIT ?
`);

/** Closed buffers past the user's GC age, minus any holding a bookmark. */
export function listGcEligibleBuffers(userId: number, days: number, limit: number): number[] {
  return (gcEligibleStmt.all(userId, days, userId, limit) as Array<{ id: number }>).map(
    (r) => r.id,
  );
}

const drainBufferStmt = db.prepare(`
  DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m
      JOIN buffers b ON b.id = m.buffer_id
     WHERE m.buffer_id = ? AND b.state = 'closed' AND ${GC_AGE.replace('closed_at', 'b.closed_at')}
       AND NOT EXISTS (
         SELECT 1 FROM user_bookmarks ub WHERE ub.user_id = ? AND ub.message_id = m.id
       )
     LIMIT ?
  )
`);

/** Delete up to `limit` rows of a buffer being collected, while it is still
 *  closed and still old enough. A return below `limit` means there is
 *  nothing more this pass may delete: the buffer is empty, or it was
 *  reopened, or a bookmark now protects a row. */
export function drainBufferBatch(
  userId: number,
  bufferId: number,
  days: number,
  limit: number,
): number {
  return drainBufferStmt.run(bufferId, days, userId, limit).changes;
}

const gcDeleteStmt = db.prepare(`
  DELETE FROM buffers
   WHERE id = ? AND user_id = ? AND state = 'closed' AND ${GC_AGE}
     AND NOT EXISTS (SELECT 1 FROM messages WHERE buffer_id = buffers.id)
`);

/** Remove the drained buffer row; the FK cascade takes its satellite rows.
 *  Refuses — returns false, deletes nothing — if the buffer was reopened,
 *  re-closed too recently, or still holds rows (a mid-drain bookmark). */
export function gcDeleteClosedBuffer(userId: number, bufferId: number, days: number): boolean {
  return gcDeleteStmt.run(bufferId, userId, days).changes > 0;
}

// ─── Import in flight ──────────────────────────────────────────────────────
// The sweeper skips whole ticks while an import runs: the import commits
// buffers (with archive closed_at values, possibly years old) before their
// messages, one transaction per batch with event-loop yields between — GC
// would collect a half-imported buffer and the rest of the import would mint
// it anew as an open row (or fail on the bookmark FK). Same idea as the
// export gate, sourced from a counter rather than a job table.
let importsInFlight = 0;
export function beginImport(): void {
  importsInFlight++;
}
export function endImport(): void {
  importsInFlight = Math.max(0, importsInFlight - 1);
}
export function importInProgress(): boolean {
  return importsInFlight > 0;
}

/** Delete up to `limit` of this user's noise rows in [sinceIso, cutoffIso) —
 *  the low-water cursor bounds the walk to territory the last completed
 *  sweep hasn't already cleared. A return below `limit` means this user's
 *  window is done. */
export function deleteNoiseBatch(
  userId: number,
  sinceIso: string,
  cutoffIso: string,
  limit: number,
): number {
  return noiseDeleteStmt.run(sinceIso, cutoffIso, userId, userId, limit).changes;
}
