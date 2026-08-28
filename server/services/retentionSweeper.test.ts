// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Integration tests for the retention sweep: real inserts through
// insertMessage (which feeds the dirty set), real deletes through
// runRetentionTick, assertions against the real messages + messages_fts
// tables. Batch/budget constants are INJECTED tiny — test cost must never
// scale with the production constants.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('../db/index.js').default;
let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let addBookmark: typeof import('../db/bookmarks.js').addBookmark;
let setUserSetting: typeof import('../db/settings.js').setUserSetting;
let runRetentionTick: typeof import('./retentionSweeper.js').runRetentionTick;
let takeDirtyBuffers: typeof import('../db/retention.js').takeDirtyBuffers;
let retentionDb: typeof import('../db/retention.js');
let __resetSweepPacing: typeof import('./retentionSweeper.js').__resetSweepPacing;

beforeAll(async () => {
  ({ default: db } = await import('../db/index.js'));
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  ({ addBookmark } = await import('../db/bookmarks.js'));
  ({ setUserSetting } = await import('../db/settings.js'));
  ({ runRetentionTick } = await import('./retentionSweeper.js'));
  ({ takeDirtyBuffers } = await import('../db/retention.js'));
  retentionDb = await import('../db/retention.js');
  ({ __resetSweepPacing } = await import('./retentionSweeper.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The pacing controller is module-global and carried across ticks on purpose,
// so without this a test inherits whatever size the previous one settled on —
// silently running at someone else's batch size rather than its own.
beforeEach(() => {
  __resetSweepPacing();
});

// Tiny knobs so the budget/backlog behavior is exercised with dozens of rows,
// not hundreds of thousands. noiseIntervalMs Infinity keeps the noise clock
// out of the count-sweep tests; the noise tests pass 0 to force it.
// Pacing is OFF here on purpose: these tests assert the statement-count budget,
// and a wall-clock budget would make them depend on how fast the box is. The
// pacing behaviour has its own describe block, which sets the knobs it needs.
const OPTS = {
  batchRows: 4,
  minBatchRows: 1,
  targetStatementMs: Infinity,
  maxTickMs: Infinity,
  maxBatchesPerTick: 100,
  idleDelayMs: 0,
  busyDelayMs: 0,
  noiseIntervalMs: Infinity,
};

const BASE = Date.parse('2026-08-26T00:00:00Z');

/** A user with their own network and `count` chat lines in #chan. Returns the
 *  ascending message ids and the buffer id they landed in. Each line's first
 *  word is `<name-sans-punctuation><i>` — unique across the whole test file,
 *  so an FTS hit count can never bleed in from another test's buffer. */
function seedBuffer(
  name: string,
  count: number,
): { userId: number; ids: number[]; bufferId: number } {
  const user = createUser(name);
  const net = createNetwork(user.id, { name, host: 'h', port: 6697, tls: true, nick: name });
  const word = name.replace(/[^a-z0-9]/g, '');
  const ids: number[] = [];
  let bufferId = 0;
  for (let i = 0; i < count; i++) {
    const r = insertMessage({
      networkId: net!.id,
      target: '#chan',
      time: new Date(BASE + i * 1000).toISOString(),
      type: 'message',
      nick: 'someone',
      text: `${word}${i} filler`,
      self: false,
    });
    ids.push(Number(r.id));
    bufferId = r.bufferId;
  }
  return { userId: user.id, ids, bufferId };
}

function rowIds(bufferId: number): number[] {
  return (
    db
      .prepare(`SELECT id FROM messages WHERE buffer_id = ? ORDER BY id ASC`)
      .all(bufferId) as Array<{ id: number }>
  ).map((r) => r.id);
}

function ftsHits(word: string): number {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?`)
    .pluck()
    .get(word) as number;
}

describe('runRetentionTick', () => {
  it('leaves an uncapped buffer alone', async () => {
    const { bufferId } = seedBuffer('ret-uncapped', 8);
    const result = await runRetentionTick(OPTS);
    expect(rowIds(bufferId)).toHaveLength(8);
    expect(result.backlog).toBe(false);
  });

  it('prunes to exactly the cap, keeping the newest rows, FTS included', async () => {
    const { userId, ids, bufferId } = seedBuffer('ret-capped', 30);
    setUserSetting(userId, 'data.retention.lines', 10);
    expect(ftsHits('retcapped3')).toBe(1);

    const result = await runRetentionTick(OPTS);

    expect(result.rowsDeleted).toBe(20);
    expect(rowIds(bufferId)).toEqual(ids.slice(20));
    // The delete trigger kept the external-content FTS table in step: a word
    // that only ever appeared in a pruned row is unfindable, a retained one
    // still hits.
    expect(ftsHits('retcapped3')).toBe(0);
    expect(ftsHits('retcapped29')).toBe(1);
  });

  it('a bookmarked row survives pruning as an extra above the cap', async () => {
    const { userId, ids, bufferId } = seedBuffer('ret-bookmark', 30);
    setUserSetting(userId, 'data.retention.lines', 10);
    expect(addBookmark(userId, ids[2])).toBe(true);

    await runRetentionTick(OPTS);

    expect(rowIds(bufferId)).toEqual([ids[2], ...ids.slice(20)]);

    // Steady state: with no new inserts the saved row is never deletable and
    // repeat ticks change nothing.
    const { markBufferDirty } = await import('../db/retention.js');
    markBufferDirty(bufferId);
    const again = await runRetentionTick(OPTS);
    expect(again.rowsDeleted).toBe(0);
    expect(rowIds(bufferId)).toEqual([ids[2], ...ids.slice(20)]);
  });

  it('a budget-exhausted tick reports backlog and later ticks finish the job', async () => {
    const { userId, ids, bufferId } = seedBuffer('ret-budget', 30);
    setUserSetting(userId, 'data.retention.lines', 5);

    const first = await runRetentionTick({ ...OPTS, maxBatchesPerTick: 2 });
    expect(first.backlog).toBe(true);
    expect(first.rowsDeleted).toBe(4); // the boundary probe spends 1, one batch of 4 spends the other

    let guard = 0;
    let backlog = true;
    while (backlog) {
      if (++guard > 10) throw new Error('sweep never converged');
      backlog = (await runRetentionTick({ ...OPTS, maxBatchesPerTick: 2 })).backlog;
    }
    expect(rowIds(bufferId)).toEqual(ids.slice(25));
  });

  it('a tick drains the dirty set; only inserts refill it', async () => {
    const { bufferId } = seedBuffer('ret-dirty', 3);
    // Everything seeded above (and here) is pending until a tick runs…
    expect(takeDirtyBuffers()).toContain(bufferId);
    // …and takeDirtyBuffers drained it, so a tick now examines nothing.
    const result = await runRetentionTick(OPTS);
    expect(result.buffersExamined).toBe(0);
  });

  it('changing the cap in settings re-marks the user’s buffers without new traffic', async () => {
    const { wireRetentionSettingsListener } = await import('./retentionSweeper.js');
    const settingsService = (await import('./settingsService.js')).default;
    const { userId, bufferId } = seedBuffer('ret-setting', 12);

    // Drain the seeding inserts so only the settings write can re-mark.
    await runRetentionTick(OPTS);
    expect(rowIds(bufferId)).toHaveLength(12);

    // The settings write alone must re-mark the user's buffers — the copy
    // promises deletion, not "deletion once the buffer next sees traffic".
    // 1000 is the smallest nonzero value validate() accepts (minNonzero);
    // the prune math itself is covered above with injected tiny caps.
    wireRetentionSettingsListener();
    const updated = settingsService.update(userId, { 'data.retention.lines': 1000 });
    expect(updated.ok).toBe(true);
    expect(takeDirtyBuffers()).toContain(bufferId);
  });

  it('a per-buffer override wins over the global — in both directions', async () => {
    const { setBufferRetentionById } = await import('../db/bufferRetention.js');
    const { markBufferDirty } = await import('../db/retention.js');
    const { userId, ids, bufferId } = seedBuffer('ret-override', 12);

    // Tighter than the (unlimited) global.
    setBufferRetentionById(userId, bufferId, 5);
    markBufferDirty(bufferId);
    await runRetentionTick(OPTS);
    expect(rowIds(bufferId)).toEqual(ids.slice(7));

    // Looser than a tight global: override 0 = explicitly unlimited HERE, so
    // the global of 3 must not touch this buffer.
    setUserSetting(userId, 'data.retention.lines', 3);
    setBufferRetentionById(userId, bufferId, 0);
    markBufferDirty(bufferId);
    await runRetentionTick(OPTS);
    expect(rowIds(bufferId)).toEqual(ids.slice(7));

    // Cleared override → the global governs again.
    setBufferRetentionById(userId, bufferId, null);
    markBufferDirty(bufferId);
    await runRetentionTick(OPTS);
    expect(rowIds(bufferId)).toEqual(ids.slice(9));
  });

  it('the noise clock ages out old noise; chat, kicks, recent noise, bookmarks survive', async () => {
    const user = createUser('noise-mix');
    const net = createNetwork(user.id, {
      name: 'noise-mix',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    const old = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    const recent = new Date().toISOString();
    const row = (type: string, time: string, text: string) => {
      const r = insertMessage({
        networkId: net!.id,
        target: '#chan',
        time,
        type,
        nick: 'someone',
        text,
        self: false,
      });
      return { id: Number(r.id), bufferId: r.bufferId };
    };
    const oldChat = row('message', old, 'kept chat');
    const oldKick = row('kick', old, 'kept kick');
    const oldTopic = row('topic', old, 'kept topic');
    const doomed = ['join', 'quit', 'motd', 'mode', 'away'].map((t) => row(t, old, `${t} noise`));
    const savedQuit = row('quit', old, 'bookmarked noise');
    const recentJoin = row('join', recent, 'recent noise');
    expect(addBookmark(user.id, savedQuit.id)).toBe(true);
    setUserSetting(user.id, 'data.retention.event_hours', 24);

    const result = await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });

    expect(result.noiseRowsDeleted).toBe(doomed.length);
    expect(rowIds(oldChat.bufferId)).toEqual(
      [oldChat, oldKick, oldTopic, savedQuit, recentJoin].map((r) => r.id),
    );
  });

  it('the noise clock is ON by default: an untouched user loses week-old noise', async () => {
    const user = createUser('noise-default');
    const net = createNetwork(user.id, {
      name: 'noise-default',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    const seed = (time: string) =>
      insertMessage({
        networkId: net!.id,
        target: '#chan',
        time,
        type: 'join',
        nick: 'someone',
        text: null,
        self: false,
      });
    const oldJoin = seed(new Date(Date.now() - 10 * 24 * 3_600_000).toISOString());
    const freshJoin = seed(new Date(Date.now() - 3_600_000).toISOString());

    await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });

    expect(rowIds(oldJoin.bufferId)).toEqual([Number(freshJoin.id)]);
  });

  it('event_hours 0 turns the noise clock off for that user', async () => {
    const user = createUser('noise-off');
    const net = createNetwork(user.id, {
      name: 'noise-off',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    setUserSetting(user.id, 'data.retention.event_hours', 0);
    const r = insertMessage({
      networkId: net!.id,
      target: '#chan',
      time: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
      type: 'quit',
      nick: 'someone',
      text: 'ancient',
      self: false,
    });

    await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });

    expect(rowIds(r.bufferId)).toEqual([Number(r.id)]);
  });

  it('changing event_hours flags the noise clock due without waiting for the interval', async () => {
    const { wireRetentionSettingsListener } = await import('./retentionSweeper.js');
    const settingsService = (await import('./settingsService.js')).default;
    const user = createUser('noise-flag');
    const net = createNetwork(user.id, {
      name: 'noise-flag',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    const r = insertMessage({
      networkId: net!.id,
      target: '#chan',
      time: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString(),
      type: 'part',
      nick: 'someone',
      text: null,
      self: false,
    });

    // Interval Infinity: only the settings-change flag can trigger the phase.
    wireRetentionSettingsListener();
    expect(settingsService.update(user.id, { 'data.retention.event_hours': 24 }).ok).toBe(true);
    await runRetentionTick(OPTS);

    expect(rowIds(r.bufferId)).toEqual([]);
  });

  it('a noise pass under budget resumes where it stopped instead of restarting', async () => {
    // Three fresh users, one old noise row each. With a budget of 2 the pass
    // MUST span ticks: the pre-fix code restarted from the first user every
    // tick, so once users outnumbered the budget the tail was never pruned
    // and backlog never cleared.
    const seeded = ['noise-q1', 'noise-q2', 'noise-q3'].map((name) => {
      const u = createUser(name);
      const net = createNetwork(u.id, { name, host: 'h', port: 6697, tls: true, nick: 'n' });
      const r = insertMessage({
        networkId: net!.id,
        target: '#chan',
        time: new Date(Date.now() - 10 * 24 * 3_600_000).toISOString(),
        type: 'join',
        nick: 'x',
        text: null,
        self: false,
      });
      return { bufferId: r.bufferId };
    });

    let guard = 0;
    let backlog = true;
    while (backlog) {
      if (++guard > 30) throw new Error('noise pass never converged');
      backlog = (await runRetentionTick({ ...OPTS, noiseIntervalMs: 0, maxBatchesPerTick: 2 }))
        .backlog;
    }
    for (const s of seeded) expect(rowIds(s.bufferId)).toEqual([]);
  });

  it('replayed noise below the cursor rewinds it and still gets swept', async () => {
    // Stored times may lie in the past (server-time tags, bouncer replay), so
    // a noise row can be INSERTED below the low-water mark a completed pass
    // left behind — territory the sweep believes is already clear. The
    // insert-side rewind is what keeps the "deleted once older than N hours"
    // promise for those rows.
    const user = createUser('noise-replay');
    const net = createNetwork(user.id, {
      name: 'noise-replay',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    const row = (time: string) =>
      insertMessage({
        networkId: net!.id,
        target: '#chan',
        time,
        type: 'quit',
        nick: 'x',
        text: null,
        self: false,
      });
    // A completed pass advances this user's cursor to their 168h-default cutoff.
    const fresh = row(new Date().toISOString());
    await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });
    expect(rowIds(fresh.bufferId)).toEqual([Number(fresh.id)]);

    // Replay lands a rows-old quit BELOW that cursor…
    const replayed = row(new Date(Date.now() - 30 * 24 * 3_600_000).toISOString());
    // …and the next pass still deletes it.
    await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });
    expect(rowIds(fresh.bufferId)).toEqual([Number(fresh.id)]);
    expect(rowIds(replayed.bufferId)).not.toContain(Number(replayed.id));
  });

  it('the rewind watermark is the LARGEST cursor, not the smallest', async () => {
    // Two users with different cursors; a replayed row for the high-cursor
    // user timed BETWEEN them. A min-based watermark early-outs on it (time
    // >= min) and the row evades the noise clock — the bug Copilot caught.
    const { setNoiseCursor, getNoiseCursor } = await import('../db/retention.js');
    const low = createUser('noise-wm-low');
    const high = createUser('noise-wm-high');
    const net = createNetwork(high.id, {
      name: 'noise-wm',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'n',
    });
    setNoiseCursor(low.id, '2026-01-01T00:00:00.000Z');
    setNoiseCursor(high.id, '2026-08-01T00:00:00.000Z');
    insertMessage({
      networkId: net!.id,
      target: '#chan',
      time: '2026-06-01T00:00:00.000Z',
      type: 'quit',
      nick: 'x',
      text: null,
      self: false,
    });
    expect(getNoiseCursor(high.id)).toBe('2026-06-01T00:00:00.000Z');
  });

  it('pass completion cannot clobber a concurrent cursor rewind', async () => {
    // The pass writes its cutoff via compare-and-advance: if a replayed row
    // rewound the cursor while the pass's deletes were in flight, the window
    // [since, cutoff) never covered it, and a blind set would re-hide it.
    const { setNoiseCursor, getNoiseCursor, advanceNoiseCursor, clearNoiseCursorForUser } =
      await import('../db/retention.js');
    const user = createUser('noise-cas');
    setNoiseCursor(user.id, '2026-08-01T00:00:00.000Z');
    // Cursor moved since the pass read it → the advance must be a no-op.
    advanceNoiseCursor(user.id, '2026-08-10T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    expect(getNoiseCursor(user.id)).toBe('2026-08-01T00:00:00.000Z');
    // Unmoved → advances normally.
    advanceNoiseCursor(user.id, '2026-08-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    expect(getNoiseCursor(user.id)).toBe('2026-08-20T00:00:00.000Z');
    clearNoiseCursorForUser(user.id);
    expect(getNoiseCursor(user.id)).toBe('');
  });

  // ── Closed-buffer GC ──────────────────────────────────────────────────────

  /** Close a buffer as of `daysAgo` days, in the exact form the close path
   *  writes (SQLite datetime, not ISO) — the eligibility query must handle it. */
  function closeBuffer(bufferId: number, daysAgo: number): void {
    db.prepare(
      `UPDATE buffers SET state = 'closed', closed_at = datetime('now', ?) WHERE id = ?`,
    ).run(`-${daysAgo} days`, bufferId);
  }
  function bufferExists(bufferId: number): boolean {
    return !!db.prepare(`SELECT 1 FROM buffers WHERE id = ?`).get(bufferId);
  }

  it('GC collects a buffer closed past the age — row, rows, and FTS — and nothing else', async () => {
    const { userId, bufferId: old } = seedBuffer('gc-old', 6);
    // A second buffer for the same user (its own network): closed too recently.
    const recentNet = createNetwork(userId, {
      name: 'gc-r',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'x',
    });
    const recent = insertMessage({
      networkId: recentNet!.id,
      target: '#recent',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'x',
      text: 'gcrecent keep',
      self: false,
    });
    // And one that is simply open — never eligible.
    const openNet = createNetwork(userId, {
      name: 'gc-o',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'x',
    });
    const open = insertMessage({
      networkId: openNet!.id,
      target: '#open',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'x',
      text: 'gcopen keep',
      self: false,
    });
    closeBuffer(old, 10);
    closeBuffer(recent.bufferId, 2);
    setUserSetting(userId, 'data.retention.closed_buffer_days', 7);
    expect(ftsHits('gcold3')).toBe(1);

    const r = await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });

    expect(r.buffersCollected).toBe(1);
    expect(r.gcRowsDeleted).toBe(6);
    expect(bufferExists(old)).toBe(false);
    expect(ftsHits('gcold3')).toBe(0);
    expect(bufferExists(recent.bufferId)).toBe(true);
    expect(rowIds(recent.bufferId)).toHaveLength(1);
    expect(bufferExists(open.bufferId)).toBe(true);
  });

  it('GC never collects a closed buffer that still holds a bookmark', async () => {
    const { userId, ids, bufferId } = seedBuffer('gc-saved', 5);
    expect(addBookmark(userId, ids[1])).toBe(true);
    closeBuffer(bufferId, 30);
    setUserSetting(userId, 'data.retention.closed_buffer_days', 7);

    const r = await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });

    expect(r.buffersCollected).toBe(0);
    expect(bufferExists(bufferId)).toBe(true);
    expect(rowIds(bufferId)).toEqual(ids);
  });

  it('GC is off by default: a closed-for-a-year buffer survives an untouched user', async () => {
    const { bufferId } = seedBuffer('gc-default', 3);
    closeBuffer(bufferId, 365);
    await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });
    expect(bufferExists(bufferId)).toBe(true);
  });

  it('GC protects a bookmark placed MID-drain: drain stops short, row delete refuses', async () => {
    // Search reaches closed buffers by design, so a user can bookmark a line
    // while its buffer is being drained. The exemption lives in the drain
    // statement itself, not just the listing — and the row delete refuses
    // while rows remain, so the bookmark can never be cascaded away.
    const { drainBufferBatch, gcDeleteClosedBuffer } = await import('../db/retention.js');
    const { userId, ids, bufferId } = seedBuffer('gc-middrain', 5);
    closeBuffer(bufferId, 30);
    expect(addBookmark(userId, ids[1])).toBe(true);
    expect(drainBufferBatch(userId, bufferId, 7, 100)).toBe(4);
    expect(gcDeleteClosedBuffer(userId, bufferId, 7)).toBe(false);
    expect(bufferExists(bufferId)).toBe(true);
    expect(rowIds(bufferId)).toEqual([ids[1]]);
  });

  it('GC stops draining a buffer that was reopened mid-drain', async () => {
    const { drainBufferBatch, gcDeleteClosedBuffer } = await import('../db/retention.js');
    const { userId, ids, bufferId } = seedBuffer('gc-reopen', 8);
    closeBuffer(bufferId, 30);
    expect(drainBufferBatch(userId, bufferId, 7, 4)).toBe(4);
    db.prepare(`UPDATE buffers SET state = 'open', closed_at = NULL WHERE id = ?`).run(bufferId);
    expect(drainBufferBatch(userId, bufferId, 7, 4)).toBe(0);
    expect(gcDeleteClosedBuffer(userId, bufferId, 7)).toBe(false);
    expect(rowIds(bufferId)).toHaveLength(4);
    expect(ids).toHaveLength(8);
  });

  it('GC makes progress even under a budget of 2 (no busy-cadence livelock)', async () => {
    // Reviewer's repro: noise probe + listing exhausted a budget of 2 before
    // any drain ran, so every tick reported backlog and deleted nothing.
    const { userId, bufferId } = seedBuffer('gc-tiny-budget', 14);
    closeBuffer(bufferId, 10);
    setUserSetting(userId, 'data.retention.closed_buffer_days', 7);
    let guard = 0;
    let backlog = true;
    while (backlog) {
      if (++guard > 60) throw new Error('GC livelocked under a tiny budget');
      backlog = (await runRetentionTick({ ...OPTS, noiseIntervalMs: 0, maxBatchesPerTick: 2 }))
        .backlog;
    }
    expect(bufferExists(bufferId)).toBe(false);
  });

  it('an in-flight import pauses the whole tick, like an export', async () => {
    const { beginImport, endImport } = await import('../db/retention.js');
    const { userId, bufferId } = seedBuffer('gc-import', 3);
    closeBuffer(bufferId, 30);
    setUserSetting(userId, 'data.retention.closed_buffer_days', 7);
    beginImport();
    try {
      const paused = await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });
      expect(paused.buffersExamined).toBe(0);
      expect(bufferExists(bufferId)).toBe(true);
    } finally {
      endImport();
    }
    await runRetentionTick({ ...OPTS, noiseIntervalMs: 0 });
    expect(bufferExists(bufferId)).toBe(false);
  });

  it('GC drains a big buffer across ticks under budget, then drops the row', async () => {
    const { userId, bufferId } = seedBuffer('gc-budget', 14);
    closeBuffer(bufferId, 10);
    setUserSetting(userId, 'data.retention.closed_buffer_days', 7);

    let guard = 0;
    let backlog = true;
    while (backlog) {
      if (++guard > 30) throw new Error('GC never converged');
      backlog = (await runRetentionTick({ ...OPTS, noiseIntervalMs: 0, maxBatchesPerTick: 3 }))
        .backlog;
    }
    expect(bufferExists(bufferId)).toBe(false);
  });

  it('an in-flight export pauses the sweep without losing the dirty set', async () => {
    const { createExportJob, deleteJob } = await import('../db/dataExports.js');
    const { userId, ids, bufferId } = seedBuffer('ret-export', 12);
    setUserSetting(userId, 'data.retention.lines', 5);

    const job = createExportJob(userId, true);
    const paused = await runRetentionTick(OPTS);
    expect(paused.buffersExamined).toBe(0);
    expect(paused.rowsDeleted).toBe(0);
    expect(rowIds(bufferId)).toHaveLength(12);

    // Job gone → the untouched dirty set prunes on the very next tick.
    deleteJob(job.id);
    await runRetentionTick(OPTS);
    expect(rowIds(bufferId)).toEqual(ids.slice(7));
  });
});

// The 2026-08-28 incident: the statement-count budget assumes each statement is
// cheap, and on a cold start it is not — one 500-row delete cascading into the
// FTS triggers blocked the loop for ~800ms a second. These pin the two things
// that stop a statement count from being the only guard.
describe('pacing', () => {
  /** Replace a delete with one that reports a FULL batch (so the loop keeps
   *  going) and burns `ms` of real synchronous time, recording the batch size
   *  it was handed. Burning wall-clock is the point: it is what the sweeper
   *  measures, and a mock that returned instantly would prove nothing. */
  function slowDelete(ms: number): number[] {
    const seen: number[] = [];
    // The first charged statement of a tick is the real boundary probe. Pin it
    // cheap and constant: otherwise a probe that happens to exceed
    // targetStatementMs on a loaded CI box halves the batch before the first
    // delete, and these assertions are about the DELETE path.
    vi.spyOn(retentionDb, 'retentionBoundaryId').mockReturnValue(1);
    vi.spyOn(retentionDb, 'deleteRetentionBatch').mockImplementation(
      (_b: number, _bound: number, _owner: number, limit: number) => {
        seen.push(limit);
        const end = performance.now() + ms;
        while (performance.now() < end) {
          /* block the loop the way a real slow statement does */
        }
        return limit; // a full batch — the tail is never "done"
      },
    );
    return seen;
  }

  beforeEach(() => {
    // Drop dirty buffers left by earlier tests BEFORE seeding this one, so the
    // deliberately tiny budgets below are spent on the buffer under test.
    takeDirtyBuffers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('halves the batch size while statements overrun the target', async () => {
    const { userId } = seedBuffer('pace-shrink', 30);
    setUserSetting(userId, 'data.retention.lines', 10);
    const seen = slowDelete(30);

    await runRetentionTick({
      ...OPTS,
      batchRows: 64,
      minBatchRows: 1,
      targetStatementMs: 10, // every mocked statement overruns this
      maxBatchesPerTick: 6,
    });

    expect(seen.length).toBeGreaterThan(2);
    expect(seen[0]).toBe(64);
    // Strictly decreasing, and it actually got small — not merely "not larger".
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]);
    expect(seen.at(-1)!).toBeLessThanOrEqual(16);
  });

  it('never shrinks below minBatchRows', async () => {
    const { userId } = seedBuffer('pace-floor', 30);
    setUserSetting(userId, 'data.retention.lines', 10);
    const seen = slowDelete(30);

    await runRetentionTick({
      ...OPTS,
      batchRows: 64,
      minBatchRows: 8,
      targetStatementMs: 10,
      maxBatchesPerTick: 12,
    });

    expect(Math.min(...seen)).toBe(8);
  });

  it('holds the batch size when targetStatementMs is Infinity', async () => {
    const { userId } = seedBuffer('pace-off', 30);
    setUserSetting(userId, 'data.retention.lines', 10);
    const seen = slowDelete(30);

    await runRetentionTick({ ...OPTS, batchRows: 64, maxBatchesPerTick: 5 });

    expect(new Set(seen)).toEqual(new Set([64]));
  });

  /** Deletes that return one row SHORT of the batch — the shape that ends a
   *  buffer's loop — instantly. Records the size each was handed. */
  function shortDelete(): number[] {
    const seen: number[] = [];
    vi.spyOn(retentionDb, 'retentionBoundaryId').mockReturnValue(1);
    vi.spyOn(retentionDb, 'deleteRetentionBatch').mockImplementation(
      (_b: number, _bound: number, _owner: number, limit: number) => {
        seen.push(limit);
        return Math.max(0, limit - 1); // short: the tail is "done"
      },
    );
    return seen;
  }

  it('does not let a short batch grow the size back', async () => {
    const PACED = {
      ...OPTS,
      batchRows: 64,
      minBatchRows: 1,
      targetStatementMs: 10,
      maxBatchesPerTick: 4,
    };
    const big = seedBuffer('pace-short-big', 60);
    setUserSetting(big.userId, 'data.retention.lines', 10);

    slowDelete(30);
    await runRetentionTick(PACED); // full+slow batches shrink the size

    // Now a tickful of buffers that each end on ONE cheap short batch. A short
    // batch is cheap because it deleted almost nothing, so it proves nothing
    // about the size — if it grew it, boot (every buffer dirty, most over cap
    // by a handful of rows) would ratchet straight back to the maximum.
    vi.restoreAllMocks();
    const seen = shortDelete();
    for (let i = 0; i < 6; i++) {
      const b = seedBuffer(`pace-short-${i}`, 30);
      setUserSetting(b.userId, 'data.retention.lines', 10);
    }
    await runRetentionTick({ ...PACED, maxBatchesPerTick: 100 });

    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(new Set(seen).size).toBe(1); // every buffer used the same size
  });

  it('does not let a cheap unsized statement grow the batch back', async () => {
    const { userId } = seedBuffer('pace-nogrow', 60);
    setUserSetting(userId, 'data.retention.lines', 10);
    const seen = slowDelete(30);
    const PACED = {
      ...OPTS,
      batchRows: 64,
      minBatchRows: 1,
      targetStatementMs: 10,
      maxBatchesPerTick: 4,
    };

    await runRetentionTick(PACED); // slow deletes shrink the batch
    const shrunk = seen.at(-1)!;
    expect(shrunk).toBeLessThan(64);

    // The mocked delete always reports a full batch, so the buffer is still
    // dirty and the next tick re-probes it. That probe is instant and takes no
    // row limit — it must teach the controller NOTHING, or boot (which seeds
    // every buffer dirty) re-inflates the batch and the ~800ms block returns.
    seen.length = 0;
    await runRetentionTick(PACED);

    // Not `shrunk`: the controller halved again after that last statement.
    // A probe that grew it would land ABOVE this, which is the regression.
    expect(seen[0]).toBe(shrunk / 2);
  });

  it('still deletes when the boundary probe alone exhausts the tick budget', async () => {
    const { userId, bufferId } = seedBuffer('pace-livelock', 30);
    setUserSetting(userId, 'data.retention.lines', 10);
    // The probe is O(cap) and cannot be batched. If it can spend the whole
    // tick budget by itself, a pre-test delete loop runs ZERO times, the
    // buffer is re-marked dirty, and the next tick repeats it — pruning stops
    // forever while still blocking the loop every busyDelayMs.
    const realBoundary = retentionDb.retentionBoundaryId;
    vi.spyOn(retentionDb, 'retentionBoundaryId').mockImplementation((b: number, cap: number) => {
      const end = performance.now() + 60;
      while (performance.now() < end) {
        /* a probe that costs more than the whole tick */
      }
      return realBoundary(b, cap);
    });

    const r = await runRetentionTick({
      ...OPTS,
      batchRows: 4,
      minBatchRows: 4,
      targetStatementMs: Infinity,
      maxTickMs: 50, // less than the probe above
      maxBatchesPerTick: 500,
    });

    expect(r.rowsDeleted).toBeGreaterThan(0);
    expect(rowIds(bufferId).length).toBeLessThan(30);
    expect(r.backlog).toBe(true); // still more to do, but it MOVED
  });

  it('ends a tick on elapsed statement time even with batches to spare', async () => {
    const { userId } = seedBuffer('pace-tick', 30);
    setUserSetting(userId, 'data.retention.lines', 10);
    const seen = slowDelete(30);

    // 500 batches available, but only ~90ms of statement time allowed: the
    // statement COUNT cannot end this tick, so only the time budget can.
    const result = await runRetentionTick({
      ...OPTS,
      batchRows: 4,
      minBatchRows: 4,
      targetStatementMs: Infinity,
      maxTickMs: 90,
      maxBatchesPerTick: 500,
    });

    expect(seen.length).toBeLessThan(10); // ~3 x 30ms, nowhere near 500
    expect(result.backlog).toBe(true);
  });
});
