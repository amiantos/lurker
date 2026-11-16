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
let refoldNetworkBuffers: typeof import('./refoldBuffers.js').refoldNetworkBuffers;
let bufferReads: typeof import('./bufferReads.js');
let pinned: typeof import('./pinnedBuffers.js');
let drafts: typeof import('./drafts.js');
let reactions: typeof import('./reactions.js');
let threads: typeof import('./threadFollows.js');
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
  ({ renameBuffer } = await import('./renameBuffer.js'));
  ({ refoldNetworkBuffers } = await import('./refoldBuffers.js'));
  bufferReads = await import('./bufferReads.js');
  pinned = await import('./pinnedBuffers.js');
  drafts = await import('./drafts.js');
  reactions = await import('./reactions.js');
  threads = await import('./threadFollows.js');
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
    expect(
      once(
        messages
          .listActiveTargetsInWindow(
            networkId,
            '2000-01-01T00:00:00.000Z',
            '2100-01-01T00:00:00.000Z',
            100,
          )
          .map((b) => b.target),
      ),
    ).toEqual([to]);
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
    // What a process killed mid-drain leaves on disk, written as the merge
    // writes it but by hand, so that no runner in this process knows of it.
    const src = resolve.resolveBuffer(userId, networkId, from)!;
    const dest = resolve.resolveBuffer(userId, networkId, to)!;
    db.prepare(`UPDATE buffers SET merged_into = ?, target_folded = ? WHERE id = ?`).run(
      src.id,
      `\u0000merging:${dest.id}`,
      dest.id,
    );
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

describe('a write that names a line not yet moved', () => {
  // The oldest line of the absorbed buffer, with a msgid, a reply under it
  // and the user following that thread: all of it older than the first chunk.
  function mergeWithOldThread(): { survivor: number; absorbed: number; root: number; to: string } {
    const { from, to } = pair();
    seedMany(from, 1);
    const stamp = (text: string, extra: object) =>
      Number(
        messages.insertMessage({
          networkId,
          target: to,
          time: new Date().toISOString(),
          type: 'message',
          nick: 'peer',
          text,
          ...extra,
        }).id,
      );
    const root = stamp('the root line', { msgid: `root-${to}` });
    stamp('a reply', {
      msgid: `reply-${to}`,
      replyMsgid: `root-${to}`,
      replyRootMsgid: `root-${to}`,
    });
    seedMany(to, 12);
    const survivor = buffers.getBuffer(userId, networkId, from)!.id;
    const absorbed = buffers.getBuffer(userId, networkId, to)!.id;
    threads.followThread(userId, absorbed, `root-${to}`, 0);
    renameBuffer(userId, networkId, from, to, CHUNK);
    expect(idsIn(absorbed)).toContain(root);
    return { survivor, absorbed, root, to };
  }

  it('a REDACT finds it, and answers with the buffer clients hold', () => {
    const { survivor, root, to } = mergeWithOldThread();
    const line = messages.redactMessage({
      networkId,
      bufferId: survivor,
      msgid: `root-${to}`,
      by: 'peer',
      time: new Date().toISOString(),
    });
    expect(line).toMatchObject({ id: root, bufferId: survivor });
    drain.drainMergesNow(CHUNK);
    expect(db.prepare(`SELECT text FROM messages WHERE id = ?`).get(root)).toEqual({ text: null });
  });

  it('a reaction and a reply find their parent', () => {
    const { survivor, root, to } = mergeWithOldThread();
    expect(reactions.findReactionParent(networkId, survivor, `root-${to}`)).toMatchObject({
      id: root,
      bufferId: survivor,
    });
    expect(messages.findReplyParent(networkId, survivor, `root-${to}`)?.id).toBe(root);
    // A reply to the reply roots where its parent does, not at the parent.
    expect(messages.replyRootFor(networkId, survivor, `reply-${to}`)).toBe(`root-${to}`);
    expect(messages.replySendMsgid(userId, networkId, to, root)).toBe(`root-${to}`);
  });

  it('a followed thread is not forgotten while its replies are on their way', () => {
    const { survivor, to } = mergeWithOldThread();
    // The list the merge's own follow-up builds: the thread has no reply in
    // the survivor yet, which is how a thread retention took looks.
    expect(threads.listFollowedThreads(userId).map((t) => t.rootMsgid)).not.toContain(`root-${to}`);
    drain.drainMergesNow(CHUNK);
    expect(
      threads
        .listFollowedThreads(userId)
        .filter((t) => t.rootMsgid === `root-${to}`)
        .map((t) => t.bufferId),
    ).toEqual([survivor]);
  });

  it('a second rename mid-drain renames the draining row with the buffer', () => {
    const { root, to } = mergeWithOldThread();
    const again = `${to}_away`;
    renameBuffer(userId, networkId, to, again, CHUNK);
    // The target a REDACT of the user's on that line would be sent to.
    expect(messages.redactSendTarget(userId, root)?.target).toBe(again);
  });
});

describe('when the drain is done', () => {
  it('says so once, for the survivor, and never for a merge that fit in a chunk', () => {
    const heard: number[] = [];
    const off = drain.onMergeDrained((id) => heard.push(id));
    try {
      const small = pair();
      seedMany(small.from, 1);
      seedMany(small.to, CHUNK);
      renameBuffer(userId, networkId, small.from, small.to, CHUNK);
      vi.runAllTimers();
      expect(heard).toEqual([]);

      const big = pair();
      seedMany(big.from, 1);
      seedMany(big.to, 12);
      const survivor = buffers.getBuffer(userId, networkId, big.from)!.id;
      renameBuffer(userId, networkId, big.from, big.to, CHUNK);
      expect(heard).toEqual([]);
      vi.runAllTimers();
      expect(heard).toEqual([survivor]);
    } finally {
      off();
    }
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

  it('moves at least what one page read scans, so the page fetched on a merge is whole', () => {
    expect(drain.MERGE_CHUNK_ROWS).toBeGreaterThanOrEqual(messages.RENDERABLE_MAX_SCAN);
  });

  it('a rolled-back merge leaves nothing draining, and the kick it queued finds nothing', () => {
    const { from, to } = pair();
    seedMany(from, 1);
    const theirs = seedMany(to, 12);
    const absorbed = buffers.getBuffer(userId, networkId, to)!.id;
    expect(() =>
      db.transaction(() => {
        renameBuffer(userId, networkId, from, to, CHUNK);
        throw new Error('caller fails after the merge');
      })(),
    ).toThrow('caller fails');
    vi.runAllTimers();
    expect(drainingRows()).toEqual([]);
    expect(idsIn(absorbed)).toEqual(theirs);
    expect(buffers.getBuffer(userId, networkId, to)?.id).toBe(absorbed);
  });

  it('takes a whole number of rows of at least one, whatever it is handed', () => {
    expect(drain.mergeChunkRows()).toBe(drain.MERGE_CHUNK_ROWS);
    expect(drain.mergeChunkRows(Infinity)).toBe(drain.MERGE_CHUNK_ROWS);
    expect(drain.mergeChunkRows(NaN)).toBe(drain.MERGE_CHUNK_ROWS);
    expect(drain.mergeChunkRows(0)).toBe(1);
    expect(drain.mergeChunkRows(7.9)).toBe(7);
  });
});
