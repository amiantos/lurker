// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The background prune loop for history retention (lurker-dev/RETENTION_PLAN.md §3.3).
//
// Shape: a self-rescheduling setTimeout chain (not setInterval — a tick that
// found work reschedules itself sooner than one that didn't, TheLounge's
// cadence). Each tick drains the dirty-buffer set fed by insertMessage,
// resolves each buffer owner's effective cap once, and works in small
// discrete statements with a setImmediate yield between them — the shared
// better-sqlite3 connection is synchronous, so the yields are what keep WS
// fan-out and IRC sockets breathing while a large backlog is chewed down.
// The tick budget counts EVERY bounded statement, boundary probes included:
// boot seeds every buffer dirty, so the first tick after start would
// otherwise chain hundreds of O(cap) index walks back-to-back — the exact
// event-loop-starvation class the connect snapshot already had an incident
// with. A tick that runs out of budget re-marks what it didn't finish and
// comes back in seconds rather than minutes; that budget, not a one-shot
// migration, is how first enablement on a big database backfills (and what
// keeps the Litestream WAL churn on hosted cells paced).
//
// Errors: warn and keep going, but stop the loop entirely after three
// consecutive failing ticks (TheLounge's circuit breaker) — a persistent SQL
// error repeating every few seconds forever is worse than pruning stopping,
// which only ever costs disk, never data. The stop is posted to the system
// buffer, not just stdout: an operator has to be able to notice it.

import {
  takeDirtyBuffers,
  markBufferDirty,
  seedAllBuffersDirty,
  seedUserBuffersDirty,
  bufferOwnerId,
  retentionBoundaryId,
  deleteRetentionBatch,
  listUserIds,
  deleteNoiseBatch,
  getNoiseCursor,
  advanceNoiseCursor,
  listGcEligibleBuffers,
  drainBufferBatch,
  gcDeleteClosedBuffer,
  importInProgress,
} from '../db/retention.js';
import { listInflightJobs } from '../db/dataExports.js';
import {
  effectiveRetentionLines,
  userRetentionLines,
  effectiveEventRetentionHours,
  effectiveClosedBufferDays,
} from './retentionLimits.js';
import settingsService from './settingsService.js';
import * as systemLog from './systemLog.js';

export interface RetentionSweepOptions {
  /** MAXIMUM rows per DELETE statement. The batch actually used is adapted
   *  down from here toward `minBatchRows` whenever a statement blocks the loop
   *  for longer than `targetStatementMs` — see `pacedBatchRows`. */
  batchRows: number;
  /** Floor for the adapted batch size. Below this the per-statement overhead
   *  dominates and the sweep stops making useful progress. */
  minBatchRows: number;
  /** How long ONE bounded statement may block the event loop before the batch
   *  size is cut. Infinity disables adaptation (tests, and anyone who wants
   *  the old fixed-size behaviour). */
  targetStatementMs: number;
  /** Total time a tick may spend INSIDE synchronous statements before handing
   *  the rest to the next one. A backstop on top of `maxBatchesPerTick`, which
   *  counts statements and so cannot bound a tick whose statements are slow.
   *  Infinity disables it. */
  maxTickMs: number;
  /** Bounded statements (boundary probes + delete batches) a single tick may
   *  spend before handing the rest to the next one. */
  maxBatchesPerTick: number;
  /** Delay before the next tick when this one finished its whole backlog. */
  idleDelayMs: number;
  /** Delay when the tick ran out of budget with work left. */
  busyDelayMs: number;
  /** How often a tick also runs the hourly per-user pass — the noise clock
   *  AND closed-buffer GC (operator ceilings included). Infinity disables
   *  both; 0 runs them every tick. */
  noiseIntervalMs: number;
}

export const RETENTION_SWEEP_DEFAULTS: RetentionSweepOptions = {
  batchRows: 500,
  minBatchRows: 25,
  // 50ms is the budget for ONE statement, not for the tick: the yields between
  // statements are what keep sockets breathing, so many short blocks are fine
  // where one long one is not. Sized against the ~120s IRC ping timeout with
  // three orders of magnitude to spare.
  targetStatementMs: 50,
  maxTickMs: 1000,
  maxBatchesPerTick: 20,
  idleDelayMs: 60 * 1000,
  busyDelayMs: 5 * 1000,
  noiseIntervalMs: 60 * 60 * 1000,
};

export interface RetentionTickResult {
  buffersExamined: number;
  rowsDeleted: number;
  /** Rows the noise clock deleted (already-aged EARLY_PRUNE_TYPES rows). */
  noiseRowsDeleted: number;
  /** Closed buffers garbage-collected this tick, and the rows drained doing it. */
  buffersCollected: number;
  gcRowsDeleted: number;
  /** Work remained when the tick's budget ran out. */
  backlog: boolean;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// ─── Pacing ────────────────────────────────────────────────────────────────
// The budget above counts STATEMENTS, which silently assumes each one is
// cheap. On a cold start it is not: a first noise pass walks a user's history
// from epoch, and a 500-row delete cascading into the FTS triggers blocked the
// loop for ~800ms a second on a 2.1 GB hosted database (2026-08-28). The
// statement count cannot express that — so measure the block and shrink the
// batch until it fits, then grow back while it does.
//
// Deliberately module-level, i.e. carried ACROSS ticks: the whole point is
// that a tick which found the work expensive hands that knowledge to the next
// one. Reset between tests with `resetSweepPacingForTests`.
//
// 0 means "nothing measured yet", which pacedBatchRows floors to minBatchRows:
// start at the FLOOR and earn the way up. Starting at `batchRows` would assume
// the maximum works, which is the assumption this whole file exists to stop
// making — and boot re-marks every buffer dirty, so that assumption would be
// re-made, and paid for, on every single restart.
// One constant for both the initial value and the reset, so a process start
// and a test reset can never disagree about what "nothing measured" means.
const UNMEASURED = 0;
let adaptedBatchRows = UNMEASURED;

/** Test-only: forget what the last tick learned about statement cost. */
export function resetSweepPacingForTests(): void {
  adaptedBatchRows = UNMEASURED;
}

/** The batch size to use right now, clamped into the option's own range. */
function pacedBatchRows(opts: RetentionSweepOptions): number {
  // The ceiling wins a contradictory pair: `batchRows` is documented as the
  // MAXIMUM, so a floor above it must not silently raise the batch past it.
  // And never 0 — a zero-row delete removes nothing while still costing a
  // charged statement, and `deleted < rows` (0 < 0) is false, so the loop
  // would not even recognise it as a short batch.
  const floor = Math.max(1, Math.min(opts.minBatchRows, opts.batchRows));
  return Math.max(floor, Math.min(opts.batchRows, adaptedBatchRows));
}

/** Run a statement, reporting how long it blocked the loop. */
function measure<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

/**
 * Feed ONE row-limited statement's cost back into the batch size. Halve on an
 * overrun, step back up gently when inside budget — slow to trust, quick to
 * back off, so a single expensive buffer cannot re-saturate the loop.
 *
 * Only ever called for statements whose cost is a function of `rows`. The
 * boundary probe (O(cap)), the GC listing (fixed limit) and the closed-buffer
 * delete take no row limit, so shrinking the batch cannot make them cheaper:
 * letting them shrink it punishes the delete path for a cost it cannot
 * reduce, and — the one that defeats the whole fix — letting a FAST one grow
 * it proves nothing about delete cost. Boot seeds every buffer dirty, so a
 * handful of quick within-cap probes would otherwise re-inflate the batch to
 * the maximum before the noise pass ran, and the ~800ms block would be back.
 *
 * Both bounds live in pacedBatchRows, the only reader — clamping here too
 * would leave a mutation to either one behaviour-neutral, i.e. untestable.
 * A targetStatementMs of Infinity needs no special case: nothing can overrun
 * it, so the size only grows and pins to `batchRows`.
 */
function adaptToStatement(opts: RetentionSweepOptions, ms: number, full: boolean): void {
  // ONLY a full batch says anything about per-row cost, in EITHER direction —
  // a full batch is row-bound by construction, because the LIMIT is what
  // stopped the walk.
  //
  // A short one is not, and shrinking on it is actively wrong: the terminal
  // `deleteNoiseBatch` of a user's window matches nothing, so the LIMIT never
  // trips and it scans the whole [since, cutoff) range of
  // `idx_messages_noise_time` — an index on (time, buffer_id) with no user_id,
  // so that range is every OTHER user's noise, the bookmarked rows, and the
  // entire backlog of anyone with event_hours = 0. It is slow for reasons no
  // batch size can change, once per user per pass, and letting it shrink would
  // walk the line-cap sweep down to the floor for free.
  if (!full) return;
  const current = pacedBatchRows(opts);
  if (ms > opts.targetStatementMs) {
    adaptedBatchRows = Math.floor(current / 2);
  } else if (ms < opts.targetStatementMs / 2) {
    // Growth requires a FULL batch. A short one is the last of a buffer or
    // user and is cheap because it deleted almost nothing — it never showed
    // that `rows` rows fit in the budget. Boot seeds every buffer dirty and
    // most are over cap by a handful of rows, so counting those would be one
    // growth step each and no shrink steps: ~14 small buffers would ratchet
    // 25 back to 500 and hand the next big buffer the ~800ms block again.
    adaptedBatchRows = Math.max(current + 1, Math.ceil(current * 1.25));
  }
}

let lastNoiseSweepMs = 0;
let noisePendingUsers: number[] | null = null;
// A settings change that lands while a pass is mid-flight asks for a fresh
// pass right after this one — completion would otherwise overwrite the
// listener's -Infinity with Date.now() and the change would wait an hour.
let passRerunRequested = false;

/**
 * One sweep pass over the currently-dirty buffers, plus — when due — the
 * noise clock's per-user age sweep. Exported for tests; the production loop
 * below is just this on a timer.
 */
export async function runRetentionTick(
  opts: RetentionSweepOptions = RETENTION_SWEEP_DEFAULTS,
): Promise<RetentionTickResult> {
  const result: RetentionTickResult = {
    buffersExamined: 0,
    rowsDeleted: 0,
    noiseRowsDeleted: 0,
    buffersCollected: 0,
    gcRowsDeleted: 0,
    backlog: false,
  };

  // A with-history export pages the messages table by ascending id with no
  // snapshot isolation (services/exportService.ts) — deleting rows ahead of
  // its cursor would silently hole the archive, and "export your data first"
  // is exactly what the retention setting's own copy tells a user about to
  // lower their cap. Skip the whole tick; the dirty set is untouched, so
  // nothing is forgotten. A crashed job can't wedge this: boot fails orphaned
  // in-flight rows (recoverInterruptedExports).
  if (listInflightJobs().length > 0) return result;
  // Same for an import: it commits buffers (with archive closed_at values)
  // before their messages, yielding between batches — GC would collect the
  // half-imported buffer and the rest of the import would mint it anew.
  if (importInProgress()) return result;

  // Per-tick cap cache: one settings read per owner, not per buffer.
  const capByUser = new Map<number, number>();
  let batchesSpent = 0;
  // Time spent INSIDE statements, not wall-clock: the awaits between them are
  // exactly what we are trying to leave room for, so they must not count.
  let syncMsSpent = 0;
  const outOfBudget = (): boolean =>
    batchesSpent >= opts.maxBatchesPerTick || syncMsSpent >= opts.maxTickMs;
  // Charge the tick, but teach the controller nothing: see adaptToStatement.
  const charge = <T>(run: () => T): T => {
    const { value, ms } = measure(run);
    syncMsSpent += ms;
    batchesSpent++;
    return value;
  };
  // Charge the tick AND size the next batch from what this one cost. Every
  // caller is a row-limited delete returning how many rows it removed, so
  // `deleted >= rows` is what "the batch was full" means.
  const chargeSized = (rows: number, run: () => number): number => {
    const { value, ms } = measure(run);
    syncMsSpent += ms;
    batchesSpent++;
    adaptToStatement(opts, ms, value >= rows);
    return value;
  };

  const pending = takeDirtyBuffers();
  for (let i = 0; i < pending.length; i++) {
    const bufferId = pending[i];
    try {
      if (outOfBudget()) {
        // Out of budget — put the rest back for the (soon) next tick.
        markBufferDirty(bufferId);
        result.backlog = true;
        continue;
      }
      // Yield BEFORE the buffer's first statement so no skip path below can
      // chain synchronous work across buffers.
      await yieldToLoop();
      const ownerId = bufferOwnerId(bufferId);
      if (ownerId === undefined) continue; // buffer deleted; cascade got the rows
      let globalLines = capByUser.get(ownerId);
      if (globalLines === undefined) {
        globalLines = userRetentionLines(ownerId);
        capByUser.set(ownerId, globalLines);
      }
      // Per-buffer: the settings read is cached above; only the override
      // lookup (one PK probe) is paid per buffer.
      const cap = effectiveRetentionLines(ownerId, bufferId, globalLines);
      result.buffersExamined++;
      if (cap <= 0) continue; // unlimited

      // The OFFSET walk is O(cap) index entries — real work, charged like a
      // delete batch.
      const boundaryId = charge(() => retentionBoundaryId(bufferId, cap));
      if (boundaryId === undefined) continue; // within cap

      // "Done" is a short delete batch, NOT an exhausted budget: keying the
      // re-mark on the budget livelocks — with a small budget every capped
      // buffer ends its visit at the limit and reports a backlog forever.
      // do/while, NOT while: the probe above is O(cap) and unbatchable, so on
      // a large cap it can spend the whole tick budget by itself. A pre-test
      // loop would then run zero times, re-mark the buffer dirty and repeat
      // the same probe every busyDelayMs — blocking the loop forever while
      // deleting nothing. Progress per visit is guaranteed instead, at an
      // overshoot of one statement (the same trade gcStep's drain makes).
      let tailDone = false;
      do {
        // Yield FIRST, like every other guaranteed-progress loop here. The
        // probe above is the one statement the batch size cannot shrink, and
        // the delete below now runs even when that probe alone spent the whole
        // budget — without this the two are one unbroken block, and maxTickMs
        // cannot help because it is only consulted between statements.
        await yieldToLoop();
        const rows = pacedBatchRows(opts);
        const deleted = chargeSized(rows, () =>
          deleteRetentionBatch(bufferId, boundaryId, ownerId, rows),
        );
        result.rowsDeleted += deleted;
        if (deleted < rows) {
          tailDone = true; // (or only bookmarks left below the boundary)
          break;
        }
      } while (!outOfBudget());
      if (!tailDone) {
        // Budget died mid-buffer — re-check soon.
        markBufferDirty(bufferId);
        result.backlog = true;
      }
    } catch (err) {
      // Put the in-flight buffer and the undrained remainder back before the
      // throw reaches the caller — a transient error (e.g. SQLITE_BUSY) must
      // not silently drop quiet over-cap buffers from tracking until the
      // next restart.
      for (let j = i; j < pending.length; j++) markBufferDirty(pending[j]);
      throw err;
    }
  }

  // ── The hourly per-user pass: noise clock, then closed-buffer GC ────────
  // Per-user, not per-buffer: both cutoffs depend only on the owner's
  // settings. Quiet and closed buffers age out here without ever being
  // dirty — the count sweep can't see them, which is the whole reason this
  // phase exists. The user queue persists across ticks; a step that runs out
  // of budget mid-user returns false and the user stays at the head.

  // The noise clock. Each user's walk is bounded below by their persisted
  // low-water cursor, so a pass costs O(rows aged since the last pass), not
  // O(everything ever retained).
  const noiseStep = async (userId: number): Promise<boolean> => {
    const hours = effectiveEventRetentionHours(userId);
    if (hours <= 0) return true; // noise clock off for this user
    const cutoffIso = new Date(Date.now() - hours * 3_600_000).toISOString();
    const sinceIso = getNoiseCursor(userId);
    if (sinceIso >= cutoffIso) return true; // nothing has aged past the cutoff since last pass
    // do/while for the same reason as the count sweep above: this step is
    // only entered with budget left, and it must delete at least one batch
    // when it is, or a user whose turn always begins on an exhausted budget
    // never progresses.
    do {
      await yieldToLoop();
      const rows = pacedBatchRows(opts);
      const deleted = chargeSized(rows, () => deleteNoiseBatch(userId, sinceIso, cutoffIso, rows));
      result.noiseRowsDeleted += deleted;
      if (deleted < rows) {
        // Window clear (survivors are bookmarked). Compare-and-advance, not a
        // blind set: an insert-side rewind can land during the awaits above,
        // and this pass's window never covered it.
        advanceNoiseCursor(userId, sinceIso, cutoffIso);
        return true;
      }
    } while (!outOfBudget());
    return false; // budget died mid-user
  };

  // Closed-buffer GC (lurker-dev/RETENTION_PLAN.md §4.5). Lists eligible
  // buffers once, then per buffer: drain rows in budgeted batches, THEN drop
  // the row — a single cascading DELETE over a big buffer would fire the FTS
  // trigger per row synchronously. Every statement re-checks the world
  // (state, age, bookmarks — see db/retention.ts), and the user's setting is
  // re-read per buffer so switching GC off mid-tick stops it at the next
  // buffer. Progress is GUARANTEED per step: the listing, the first drain
  // batch and the row delete run even on an exhausted budget — an overshoot of
  // 3 statements, and of maxTickMs by their duration, since the budget is only
  // consulted between statements. Bounded in practice because the drain uses
  // the paced batch size, which by then reflects what a statement costs here.
  // otherwise a small budget could be spent entirely on the noise probe and
  // the listing every tick and never reach a drain — a busy-cadence livelock.
  const GC_LIST_LIMIT = 50;
  const gcStep = async (userId: number): Promise<boolean> => {
    for (;;) {
      const days = effectiveClosedBufferDays(userId);
      if (days <= 0) return true; // GC off for this user
      // the listing (with its bookmark subquery) is a real statement
      const eligible = charge(() => listGcEligibleBuffers(userId, days, GC_LIST_LIMIT));
      if (eligible.length === 0) return true;
      for (const bufferId of eligible) {
        const daysNow = effectiveClosedBufferDays(userId);
        if (daysNow <= 0) return true; // turned off mid-tick: stop here
        let drained = false;
        do {
          await yieldToLoop();
          const rows = pacedBatchRows(opts);
          const deleted = chargeSized(rows, () =>
            drainBufferBatch(userId, bufferId, daysNow, rows),
          );
          result.gcRowsDeleted += deleted;
          if (deleted < rows) {
            drained = true; // empty — or reopened / re-closed / bookmarked, all refused below
            break;
          }
        } while (!outOfBudget());
        if (!drained) return false; // budget died mid-drain; re-listed next pass
        // the row delete cascades into eight tables — real work
        if (charge(() => gcDeleteClosedBuffer(userId, bufferId, daysNow)))
          result.buffersCollected++;
        // A refusal (reopened, re-closed recently, or a bookmark landed) is
        // simply left alone; the next pass re-derives eligibility from scratch.
        if (outOfBudget()) return false; // user stays at head
      }
      if (eligible.length < GC_LIST_LIMIT) return true; // that was everything
    }
  };

  if (noisePendingUsers !== null || Date.now() - lastNoiseSweepMs >= opts.noiseIntervalMs) {
    if (noisePendingUsers === null) noisePendingUsers = listUserIds();
    while (noisePendingUsers.length > 0 && !outOfBudget()) {
      const userId = noisePendingUsers[0];
      if (!(await noiseStep(userId))) break;
      // Re-check between the two: noiseStep can finish its window (returning
      // true) on the statement that spent the rest of the budget, and gcStep's
      // listing + guaranteed drain + row delete is exactly the synchronous work
      // maxTickMs exists to stop. The user stays at the head, so their GC runs
      // first thing next tick — by which point their noise window is clear and
      // noiseStep is cheap.
      if (outOfBudget()) break;
      if (!(await gcStep(userId))) break;
      noisePendingUsers.shift();
    }
    if (noisePendingUsers.length === 0) {
      noisePendingUsers = null;
      lastNoiseSweepMs = passRerunRequested ? -Infinity : Date.now();
      passRerunRequested = false;
    } else {
      result.backlog = true; // the pass resumes from the queue head next tick
    }
  }

  return result;
}

let settingsListenerWired = false;

/**
 * React to retention settings changes. Without this, a lowered line cap only
 * takes effect per-buffer on the next insert or the next restart — and the
 * settings copy promises deletion, not "deletion, eventually, if the buffer
 * stays active". An event_hours change flags the noise clock due instead:
 * that sweep is per-user, so there is no per-buffer state to seed. Exported
 * for tests; idempotent.
 */
export function wireRetentionSettingsListener(): void {
  if (settingsListenerWired) return;
  settingsListenerWired = true;
  settingsService.on('event', ({ userId, changes }) => {
    if (Object.prototype.hasOwnProperty.call(changes, 'data.retention.lines')) {
      seedUserBuffersDirty(userId);
    }
    if (
      Object.prototype.hasOwnProperty.call(changes, 'data.retention.event_hours') ||
      Object.prototype.hasOwnProperty.call(changes, 'data.retention.closed_buffer_days')
    ) {
      // Force the clock due (-Infinity is due under ANY interval); if a pass
      // is mid-flight and already past this user, re-queue them so a lowered
      // cutoff acts now instead of next hour.
      lastNoiseSweepMs = -Infinity;
      if (noisePendingUsers !== null) {
        passRerunRequested = true; // the in-flight pass may already be past (or AT) this user
        if (!noisePendingUsers.includes(userId)) noisePendingUsers.push(userId);
      }
    }
  });
}

let started = false;

export function startRetentionSweeper(
  opts: RetentionSweepOptions = RETENTION_SWEEP_DEFAULTS,
): void {
  if (started) return;
  started = true;
  seedAllBuffersDirty();
  wireRetentionSettingsListener();
  let consecutiveFailures = 0;
  const schedule = (delayMs: number) => {
    setTimeout(() => void tick(), delayMs).unref();
  };
  const tick = async () => {
    try {
      const r = await runRetentionTick(opts);
      consecutiveFailures = 0;
      schedule(r.backlog ? opts.busyDelayMs : opts.idleDelayMs);
    } catch (err) {
      consecutiveFailures++;
      console.warn('[lurker] retention sweep failed:', (err as Error).message);
      if (consecutiveFailures >= 3) {
        systemLog.log({
          level: 'error',
          scope: 'server',
          text:
            'Retention sweeping stopped after 3 consecutive failures; history is ' +
            'no longer being pruned. Restart the server to resume.',
        });
        return;
      }
      schedule(opts.idleDelayMs);
    }
  };
  schedule(opts.idleDelayMs);
}
