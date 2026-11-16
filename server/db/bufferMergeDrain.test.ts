// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A merge too big for one transaction (#1307): the newest chunk moves with
// the merge, the absorbed row stays behind out of sight, and the rest follow.
// Every test injects the chunk size, so none of them costs what the
// production constant would.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-merge-drain-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let buffers: typeof import('./buffers.js');
let resolve: typeof import('./bufferResolve.js');
let messages: typeof import('./messages.js');
let retention: typeof import('./retention.js');
let drain: typeof import('./bufferMergeDrain.js');
let renameBuffer: typeof import('./renameBuffer.js').renameBuffer;
let absorbBufferRow: typeof import('./renameBuffer.js').absorbBufferRow;
let refoldNetworkBuffers: typeof import('./refoldBuffers.js').refoldNetworkBuffers;
let bufferReads: typeof import('./bufferReads.js');
let pinned: typeof import('./pinnedBuffers.js');
let drafts: typeof import('./drafts.js');
let createNetwork: typeof import('./networks.js').createNetwork;
let userId: number;
let networkId: number;
let serial = 0;

const CHUNK = 5;

function seed(target: string, text: string, net = networkId): number {
  return Number(
    messages.insertMessage({
      networkId: net,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'peer',
      text,
    }).id,
  );
}

function seedMany(target: string, n: number, net = networkId): number[] {
  return Array.from({ length: n }, (_, i) => seed(target, `${target} line ${i}`, net));
}

/** A fresh pair of nicks per test: `old` is the live DM, `new` the one it
 *  absorbs when the peer takes that nick. */
function pair(): { from: string; to: string } {
  serial += 1;
  return { from: `old${serial}`, to: `new${serial}` };
}

const idsIn = (bufferId: number): number[] =>
  (
    db.prepare(`SELECT id FROM messages WHERE buffer_id = ? ORDER BY id`).all(bufferId) as Array<{
      id: number;
    }>
  ).map((r) => r.id);

const drainingRows = (): Array<{ id: number; merged_into: number }> =>
  db
    .prepare(`SELECT id, merged_into FROM buffers WHERE merged_into IS NOT NULL ORDER BY id`)
    .all() as Array<{ id: number; merged_into: number }>;

beforeAll(async () => {
  ({ default: db } = await import('./index.js'));
  const { createUser } = await import('./users.js');
  ({ createNetwork } = await import('./networks.js'));
  buffers = await import('./buffers.js');
  resolve = await import('./bufferResolve.js');
  messages = await import('./messages.js');
  retention = await import('./retention.js');
  drain = await import('./bufferMergeDrain.js');
  ({ renameBuffer, absorbBufferRow } = await import('./renameBuffer.js'));
  ({ refoldNetworkBuffers } = await import('./refoldBuffers.js'));
  bufferReads = await import('./bufferReads.js');
  pinned = await import('./pinnedBuffers.js');
  drafts = await import('./drafts.js');
  userId = createUser('drain-alice').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'a',
  })!.id;
  // The background drain runs on setImmediate; faked, a test moves it by hand
  // and nothing runs behind its back.
  vi.useFakeTimers({ toFake: ['setImmediate', 'setTimeout', 'clearTimeout'] });
});

// Whatever a test left draining finishes here, so the runner is idle (and
// nothing is draining) when the next one starts.
afterEach(() => {
  vi.runAllTimers();
  drain.drainMergesNow(CHUNK);
  vi.runAllTimers();
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a merge that fits in one chunk', () => {
  it('is the merge it always was: everything moves, the absorbed row is deleted', () => {
    const { from, to } = pair();
    const own = seedMany(from, 2);
    const theirs = seedMany(to, CHUNK); // exactly one chunk: the boundary
    const survivor = buffers.getBuffer(userId, networkId, from)!.id;
    const absorbed = buffers.getBuffer(userId, networkId, to)!.id;

    const result = renameBuffer(userId, networkId, from, to, CHUNK)!;
    expect(result).toMatchObject({
      merged: true,
      bufferId: survivor,
      mergedFromBufferId: absorbed,
    });
    expect(result).not.toHaveProperty('draining');
    expect(idsIn(survivor)).toEqual([...own, ...theirs].sort((a, b) => a - b));
    expect(db.prepare(`SELECT 1 FROM buffers WHERE id = ?`).get(absorbed)).toBeUndefined();
    expect(drainingRows()).toEqual([]);
  });
});

describe('a merge bigger than one chunk', () => {
  it('moves the newest chunk with the merge and the rest in chunk-sized steps', () => {
    const { from, to } = pair();
    const own = seedMany(from, 3);
    const theirs = seedMany(to, 12);
    const survivor = buffers.getBuffer(userId, networkId, from)!.id;
    const absorbed = buffers.getBuffer(userId, networkId, to)!.id;

    const result = renameBuffer(userId, networkId, from, to, CHUNK)!;
    expect(result).toMatchObject({
      merged: true,
      bufferId: survivor,
      mergedFromBufferId: absorbed,
    });

    // The newest five moved; the seven older ones wait under the old id.
    expect(idsIn(survivor)).toEqual([...own, ...theirs.slice(-CHUNK)]);
    expect(idsIn(absorbed)).toEqual(theirs.slice(0, -CHUNK));
    expect(drainingRows()).toEqual([{ id: absorbed, merged_into: survivor }]);
    // What a client fetches on the merged frame, the latest page, is whole.
    expect(messages.listMessages(networkId, to, { limit: CHUNK }).map((m) => m.id)).toEqual(
      theirs.slice(-CHUNK),
    );

    // Step by step: this is what pins the injected chunk size. Seven rows
    // left take two steps of five, and the row goes with the last of them.
    expect(drain.drainMergeChunk(CHUNK)).toBe(true);
    expect(idsIn(absorbed)).toEqual(theirs.slice(0, 2));
    expect(drainingRows()).toHaveLength(1);
    expect(drain.drainMergeChunk(CHUNK)).toBe(true);
    expect(drainingRows()).toEqual([]);
    expect(db.prepare(`SELECT 1 FROM buffers WHERE id = ?`).get(absorbed)).toBeUndefined();
    expect(drain.drainMergeChunk(CHUNK)).toBe(false);

    expect(idsIn(survivor)).toEqual([...own, ...theirs].sort((a, b) => a - b));
    // The search index followed every row it was told about.
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`);
  });

  it('the draining row is no buffer: no name, no id, no listing, no satellites', () => {
    const { from, to } = pair();
    seedMany(from, 1);
    const theirs = seedMany(to, 12);
    const survivor = buffers.getBuffer(userId, networkId, from)!.id;
    const absorbed = buffers.getBuffer(userId, networkId, to)!.id;
    // State on BOTH sides: the survivor keeps its own, so the absorbed
    // side's rows lose and are left where they were. With the row deleted the
    // cascade took them; a row that stays has to be cleared by hand.
    for (const name of [from, to]) {
      bufferReads.setReadState(userId, networkId, name, theirs[3]);
      pinned.pinBuffer(userId, networkId, name);
      drafts.upsertDraft(userId, networkId, name, `draft in ${name}`);
    }
    buffers.setAutojoin(userId, networkId, to, true);

    renameBuffer(userId, networkId, from, to, CHUNK);
    expect(drainingRows()).toEqual([{ id: absorbed, merged_into: survivor }]);

    // The name belongs to the survivor, and the old name to nobody.
    expect(resolve.resolveBuffer(userId, networkId, to)?.id).toBe(survivor);
    expect(resolve.resolveBuffer(userId, networkId, from)).toBeUndefined();
    expect(resolve.getBufferById(absorbed)).toBeUndefined();
    expect(resolve.requireBufferForUser(userId, absorbed)).toBeUndefined();

    const listed = (rows: Array<{ id: number }>) => rows.map((r) => r.id);
    expect(listed(buffers.listForUser(userId))).not.toContain(absorbed);
    expect(listed(buffers.listForNetwork(networkId))).not.toContain(absorbed);
    expect(listed(buffers.listStatesForUser(userId))).not.toContain(absorbed);
    expect(listed(buffers.listOpenDms(networkId))).not.toContain(absorbed);
    expect(listed(buffers.listAutojoinChannels(networkId))).not.toContain(absorbed);
    // By name: the merged conversation is listed once, not once per row.
    const once = (names: string[]) => names.filter((n) => n === to);
    expect(once(messages.listBufferTargets(networkId))).toEqual([to]);
    expect(once(messages.listBuffersForNetwork(networkId).map((b) => b.target))).toEqual([to]);
    expect(once(messages.maxIdByBuffer(networkId).map((b) => b.target))).toEqual([to]);
    // Closed is how the row is filed, and it is not a closed buffer either.
    expect(
      [...buffers.closedFoldedSetForNetwork(networkId)].filter((f) => f.includes('merging')),
    ).toEqual([]);

    // Satellites: the survivor's own, and none left under the old id.
    expect(pinned.listPinnedForUserNetwork(userId, networkId)).toContain(to);
    expect(pinned.listPinnedWithIds(userId, networkId).map((p) => p.bufferId)).not.toContain(
      absorbed,
    );
    expect(drafts.listForUser(userId).find((d) => d.target === to)?.body).toBe(`draft in ${from}`);
    expect(bufferReads.getReadState(userId, networkId, to)).toBe(theirs[3]);
    for (const table of [
      'buffer_reads',
      'pinned_buffers',
      'favorite_buffers',
      'user_drafts',
      'input_history',
    ]) {
      const left = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE buffer_id = ?`)
        .get(absorbed) as { n: number };
      expect({ table, left: left.n }).toEqual({ table, left: 0 });
    }
  });

  it('a line for the name lands in the survivor from the first chunk on', () => {
    const { from, to } = pair();
    seedMany(from, 1);
    seedMany(to, 12);
    const survivor = buffers.getBuffer(userId, networkId, from)!.id;
    const absorbed = buffers.getBuffer(userId, networkId, to)!.id;
    renameBuffer(userId, networkId, from, to, CHUNK);
    expect(drainingRows()).toHaveLength(1);

    const live = seed(to, 'said mid-drain');
    expect(idsIn(survivor)).toContain(live);
    expect(idsIn(absorbed)).not.toContain(live);
    // And no second buffer was minted for the name the draining row gave up.
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM buffers WHERE network_id = ? AND target = ?`)
        .get(networkId, to),
    ).toEqual({ n: 2 }); // the survivor and the draining row, until it is done
    drain.drainMergesNow(CHUNK);
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM buffers WHERE network_id = ? AND target = ?`)
        .get(networkId, to),
    ).toEqual({ n: 1 });
  });
});

describe('the background drain', () => {
  it('starts by itself after the merge and gives the loop back between chunks', () => {
    const { from, to } = pair();
    seedMany(from, 1);
    const theirs = seedMany(to, 17);
    const absorbed = buffers.getBuffer(userId, networkId, to)!.id;
    renameBuffer(userId, networkId, from, to, CHUNK);
    expect(idsIn(absorbed)).toHaveLength(12);

    // One turn of the loop, one chunk.
    vi.advanceTimersToNextTimer();
    expect(idsIn(absorbed)).toHaveLength(7);
    vi.advanceTimersToNextTimer();
    expect(idsIn(absorbed)).toHaveLength(2);
    vi.runAllTimers();
    expect(drainingRows()).toEqual([]);
    expect(idsIn(buffers.getBuffer(userId, networkId, to)!.id)).toEqual(
      expect.arrayContaining(theirs),
    );
  });

  it('a restart picks up a drain the last process left: kick with nothing else said', () => {
    const { from, to } = pair();
    seedMany(from, 1);
    const theirs = seedMany(to, 12);
    // What a process killed mid-drain leaves on disk: the merge committed,
    // and no runner knows of it (the absorb alone starts none).
    const src = resolve.resolveBuffer(userId, networkId, from)!;
    const dest = resolve.resolveBuffer(userId, networkId, to)!;
    db.transaction(() => absorbBufferRow(userId, networkId, src, dest, CHUNK))();
    expect(drainingRows()).toEqual([{ id: dest.id, merged_into: src.id }]);
    expect(vi.getTimerCount()).toBe(0);

    // Boot: server.ts calls kickMergeDrain, knowing nothing of what was left.
    drain.kickMergeDrain(CHUNK);
    vi.runAllTimers();
    expect(drainingRows()).toEqual([]);
    expect(idsIn(src.id)).toEqual(expect.arrayContaining(theirs));
  });

  it('tries a failed chunk again later, and keeps what was already moved', () => {
    const { from, to } = pair();
    seedMany(from, 1);
    seedMany(to, 12);
    const absorbed = buffers.getBuffer(userId, networkId, to)!.id;
    renameBuffer(userId, networkId, from, to, CHUNK);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A write lock held by another connection, and no patience for it: the
    // chunk's BEGIN IMMEDIATE throws SQLITE_BUSY.
    const other = new Database(process.env.DATABASE_PATH!);
    other.exec('BEGIN IMMEDIATE');
    db.pragma('busy_timeout = 0');
    try {
      vi.advanceTimersToNextTimer();
    } finally {
      db.pragma('busy_timeout = 5000');
      other.exec('ROLLBACK');
      other.close();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(idsIn(absorbed)).toHaveLength(7);
    vi.runAllTimers();
    expect(drainingRows()).toEqual([]);
    warn.mockRestore();
  });
});

describe('merges that meet a drain in progress', () => {
  it('a survivor absorbed in turn hands its draining rows to the new survivor', () => {
    const a = pair();
    const c = `third${serial}`;
    seedMany(a.from, 1);
    const bRows = seedMany(a.to, 12);
    renameBuffer(userId, networkId, a.from, a.to, CHUNK); // a.from absorbs a.to
    const first = drainingRows();
    expect(first).toHaveLength(1);

    // A third DM's peer takes the same nick before the drain is done: that
    // DM survives, and absorbs the survivor of the first merge.
    seedMany(c, 1);
    const cId = buffers.getBuffer(userId, networkId, c)!.id;
    renameBuffer(userId, networkId, c, a.to, CHUNK);

    // Nothing drains into a row that is itself gone or going.
    for (const row of drainingRows()) expect(row.merged_into).toBe(cId);
    drain.drainMergesNow(CHUNK);
    expect(drainingRows()).toEqual([]);
    expect(idsIn(cId)).toEqual(expect.arrayContaining(bRows));
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE buffer_id = ?`).get(cId)).toEqual({
      n: 14,
    });
  });

  it('deleting the survivor mid-drain takes the rows not yet moved with it', () => {
    const { from, to } = pair();
    seedMany(from, 1);
    const theirs = seedMany(to, 12);
    renameBuffer(userId, networkId, from, to, CHUNK);
    expect(drainingRows()).toHaveLength(1);

    expect(buffers.deleteBuffer(userId, networkId, to)).toBe(true);
    expect(drainingRows()).toEqual([]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE id IN (${theirs.join(',')})`).get(),
    ).toEqual({ n: 0 });
  });

  it('a casemapping refold drains the same way, and leaves a draining row out of the next refold', () => {
    const net = createNetwork(userId, {
      name: 'refold',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'a',
    })!.id;
    buffers.ensureOpen(userId, net, '#foo[bar]');
    buffers.ensureOpen(userId, net, '#foo{bar}');
    const kept = seedMany('#foo[bar]', 2, net);
    const moved = seedMany('#foo{bar}', 12, net);
    buffers.close(userId, net, '#foo{bar}'); // the open row survives

    const merges = refoldNetworkBuffers(userId, net, 'rfc1459', CHUNK);
    expect(merges).toHaveLength(1);
    const { survivorId, absorbedId } = merges[0];
    expect(drainingRows()).toEqual([{ id: absorbedId, merged_into: survivorId }]);

    // A second refold (the mapping declared again) sees one buffer, not two.
    expect(refoldNetworkBuffers(userId, net, 'rfc1459', CHUNK)).toEqual([]);
    expect(drainingRows()).toEqual([{ id: absorbedId, merged_into: survivorId }]);

    drain.drainMergesNow(CHUNK);
    expect(idsIn(survivorId)).toEqual([...kept, ...moved]);
  });
});

describe('retention and a drain', () => {
  it('does not sweep the draining row, and re-examines the survivor when it is done', () => {
    const { from, to } = pair();
    seedMany(from, 1);
    seedMany(to, 12);
    const survivor = buffers.getBuffer(userId, networkId, from)!.id;
    const absorbed = buffers.getBuffer(userId, networkId, to)!.id;
    renameBuffer(userId, networkId, from, to, CHUNK);

    // The sweeper skips a buffer with no owner (its line cap would be counted
    // over the tail of a history, and cut lines the survivor's cap keeps).
    expect(retention.bufferOwnerId(absorbed)).toBeUndefined();
    expect(retention.bufferOwnerId(survivor)).toBe(userId);

    retention.takeDirtyBuffers();
    drain.drainMergesNow(CHUNK);
    expect(retention.takeDirtyBuffers()).toContain(survivor);
  });

  it('does not collect a closed buffer that history is still draining into', () => {
    const { from, to } = pair();
    seedMany(from, 1);
    seedMany(to, 12);
    const survivor = buffers.getBuffer(userId, networkId, from)!.id;
    buffers.close(userId, networkId, from);
    buffers.close(userId, networkId, to);
    renameBuffer(userId, networkId, from, to, CHUNK);
    expect(drainingRows()).toHaveLength(1);
    db.prepare(`UPDATE buffers SET closed_at = '2001-01-01 00:00:00' WHERE id = ?`).run(survivor);

    expect(retention.listGcEligibleBuffers(userId, 1, 100)).not.toContain(survivor);
    // Emptied by the sweeper's own drain, it still may not be deleted: the
    // delete would cascade to the rows that have not arrived.
    db.prepare(`DELETE FROM messages WHERE buffer_id = ?`).run(survivor);
    expect(retention.gcDeleteClosedBuffer(userId, survivor, 1)).toBe(false);

    drain.drainMergesNow(CHUNK);
    expect(retention.listGcEligibleBuffers(userId, 1, 100)).toContain(survivor);
  });
});

describe('the chunk statement', () => {
  it('reads its chunk off the per-buffer index: no sort, no scan of messages', () => {
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${drain.MOVE_CHUNK_SQL}`).all(1, 2, CHUNK) as Array<{
        detail: string;
      }>
    ).map((r) => r.detail);
    expect(plan.join('\n')).toMatch(/idx_messages_buf_unread \(buffer_id=\?\)/);
    expect(plan.join('\n')).not.toMatch(/TEMP B-TREE/);
    expect(plan.filter((d) => d.startsWith('SCAN messages'))).toEqual([]);
  });

  it('takes a whole number of rows of at least one, whatever it is handed', () => {
    expect(drain.mergeChunkRows()).toBe(drain.MERGE_CHUNK_ROWS);
    expect(drain.mergeChunkRows(Infinity)).toBe(drain.MERGE_CHUNK_ROWS);
    expect(drain.mergeChunkRows(NaN)).toBe(drain.MERGE_CHUNK_ROWS);
    expect(drain.mergeChunkRows(0)).toBe(1);
    expect(drain.mergeChunkRows(7.9)).toBe(7);
  });
});
