// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The stored unread count (#1436) against a count made the slow way. Every
// case ends by comparing the two, so what is pinned is "the stored number is
// the true number", not how it got there.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-unread-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let dbIndex: typeof import('./index.js');
let messages: typeof import('./messages.js');
let bufferReads: typeof import('./bufferReads.js');
let unread: typeof import('./unreadCounts.js');
let filler: typeof import('../services/unreadFiller.js');
let buffers: typeof import('./buffers.js');
let userId: number;
let netId: number;

beforeAll(async () => {
  dbIndex = await import('./index.js');
  db = dbIndex.default;
  const { createUser } = await import('./users.js');
  const { createNetwork } = await import('./networks.js');
  messages = await import('./messages.js');
  bufferReads = await import('./bufferReads.js');
  unread = await import('./unreadCounts.js');
  filler = await import('../services/unreadFiller.js');
  buffers = await import('./buffers.js');
  userId = createUser('unread-alice').id;
  netId = createNetwork(userId, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'a' })!.id;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

afterEach(() => {
  unread.setUnreadWalkRowsForTests(null);
  unread.resetUnreadFillQueueForTests();
});

let seq = 0;
function say(
  target: string,
  over: Partial<Parameters<typeof messages.insertMessage>[0]> = {},
): number {
  seq += 1;
  return Number(
    messages.insertMessage({
      networkId: netId,
      target,
      time: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
      type: 'message',
      nick: 'bob',
      text: `line ${seq}`,
      ...over,
    }).id,
  );
}

function bufferId(target: string): number {
  return buffers.ensureExists(userId, netId, target).record.id;
}

function pointer(target: string): number {
  return bufferReads.getReadState(userId, netId, target);
}

interface Stored {
  afterId: number;
  count: number | null;
  replies: number;
  fillId: number | null;
}

function stored(target: string): Stored {
  return db
    .prepare(
      `SELECT unread_after_id AS afterId, unread_count AS count, unread_replies AS replies,
              unread_fill_id AS fillId FROM buffers WHERE id = ?`,
    )
    .get(bufferId(target)) as Stored;
}

// The slow way: every row past the pointer, judged in JS.
function truth(target: string, after = pointer(target)): { count: number; replies: number } {
  const server = target.startsWith(':server:');
  const rows = db
    .prepare(`SELECT * FROM messages WHERE buffer_id = ? AND id > ?`)
    .all(bufferId(target), after) as Array<{
    type: string;
    from_ignored: number;
    notable: number;
    reply_root_msgid: string | null;
    matched_rule_id: number | null;
    reply_to_self: number;
  }>;
  const types = server ? ['message', 'action', 'notice', 'error'] : ['message', 'action', 'notice'];
  const counted = rows.filter(
    (r) => !r.from_ignored && types.includes(r.type) && (!server || r.notable === 1),
  );
  return {
    count: counted.length,
    replies: counted.filter(
      (r) => r.reply_root_msgid !== null && r.matched_rule_id === null && !r.reply_to_self,
    ).length,
  };
}

/** The stored count is whole, for the real pointer, and right. */
function expectExact(target: string): void {
  // The first ask may only queue a fill; the answer is what follows it.
  unread.readUnreadCount(bufferId(target), pointer(target));
  filler.drainUnreadFillsForTests();
  const want = truth(target);
  expect(unread.readUnreadCount(bufferId(target), pointer(target))).toEqual(want);
  const row = stored(target);
  expect({ count: row.count, replies: row.replies, fillId: row.fillId }).toEqual({
    ...want,
    fillId: null,
  });
}

describe('the triggers keep a counted buffer exact', () => {
  it('counts a buffer the first time it is read, then follows every insert', () => {
    say('#a');
    say('#a', { type: 'join' });
    say('#a', { type: 'action' });
    expect(stored('#a').count).toBeNull();
    expectExact('#a');
    expect(stored('#a').count).toBe(2);

    say('#a');
    say('#a', { type: 'notice' });
    say('#a', { type: 'part' });
    say('#a', { type: 'error' });
    say('#a', { fromIgnored: true });
    // Read off the row: nothing walked the buffer again.
    expect(stored('#a').count).toBe(4);
    expectExact('#a');
  });

  it('counts the replies threads hide, and not a highlighted one', () => {
    say('#replies');
    expectExact('#replies');
    say('#replies', { replyRootMsgid: 'root-1', replyMsgid: 'root-1' });
    say('#replies', { replyRootMsgid: 'root-1', replyMsgid: 'root-1', matchedRuleId: 7 });
    say('#replies', { replyRootMsgid: 'root-1', replyMsgid: 'root-1', replyToSelf: true });
    expect(stored('#replies')).toMatchObject({ count: 4, replies: 1 });
    expectExact('#replies');
    expect(messages.countUnread(netId, '#replies', pointer('#replies'))).toBe(4);
    expect(
      messages.countUnread(netId, '#replies', pointer('#replies'), { threadsHidden: true }),
    ).toBe(3);
  });

  it('applies the server buffer rule: errors count, status notices do not', () => {
    const target = `:server:${netId}`;
    say(target, { type: 'notice' });
    expectExact(target);
    say(target, { type: 'error' });
    say(target, { type: 'notice', notable: false });
    say(target, { type: 'notice' });
    expect(stored(target).count).toBe(3);
    expectExact(target);
    // Threads are a channel feature: the server buffer never gives replies up.
    expect(messages.countUnread(netId, target, pointer(target), { threadsHidden: true })).toBe(3);
  });

  it('follows rows deleted from under it (retention)', () => {
    const ids = [say('#del'), say('#del'), say('#del'), say('#del')];
    bufferReads.setReadState(userId, netId, '#del', ids[0]!);
    expectExact('#del');
    expect(stored('#del').count).toBe(3);
    // One read row and one unread row go: only the unread one moves the count.
    db.prepare(`DELETE FROM messages WHERE id IN (?, ?)`).run(ids[0], ids[1]);
    expect(stored('#del').count).toBe(2);
    expectExact('#del');
  });

  it('follows rows moved between buffers (a merge)', () => {
    const from = [say('#from'), say('#from'), say('#from', { replyRootMsgid: 'r' })];
    say('#into');
    bufferReads.setReadState(userId, netId, '#from', from[0]!);
    expectExact('#from');
    expectExact('#into');
    db.prepare(`UPDATE messages SET buffer_id = ? WHERE buffer_id = ?`).run(
      bufferId('#into'),
      bufferId('#from'),
    );
    expect(stored('#from')).toMatchObject({ count: 0, replies: 0 });
    // All three arrive unread: #into's own pointer is what they are past.
    expect(stored('#into')).toMatchObject({ count: 4, replies: 1 });
    expectExact('#from');
    expectExact('#into');
  });

  it('follows a row whose standing changes after it is stored', () => {
    const id = say('#flip', { replyRootMsgid: 'r', matchedRuleId: 3 });
    expectExact('#flip');
    expect(stored('#flip')).toMatchObject({ count: 1, replies: 0 });
    db.prepare(`UPDATE messages SET matched_rule_id = NULL WHERE id = ?`).run(id);
    expect(stored('#flip')).toMatchObject({ count: 1, replies: 1 });
    db.prepare(`UPDATE messages SET from_ignored = 1 WHERE id = ?`).run(id);
    expect(stored('#flip')).toMatchObject({ count: 0, replies: 0 });
    // A redaction rewrites the text and nothing the rule reads.
    db.prepare(`UPDATE messages SET from_ignored = 0, text = NULL WHERE id = ?`).run(id);
    expectExact('#flip');
  });
});

describe('the read pointer', () => {
  it('reading to the end leaves nothing', () => {
    say('#end');
    const last = say('#end');
    expectExact('#end');
    bufferReads.setReadState(userId, netId, '#end', last);
    expect(stored('#end')).toMatchObject({ afterId: last, count: 0, replies: 0 });
    say('#end');
    expect(stored('#end').count).toBe(1);
    expectExact('#end');
  });

  it('reading part of the way leaves the rest', () => {
    const ids = [say('#part'), say('#part'), say('#part', { type: 'join' }), say('#part')];
    expectExact('#part');
    bufferReads.setReadState(userId, netId, '#part', ids[1]!);
    expect(stored('#part')).toMatchObject({ afterId: ids[1], count: 1 });
    expectExact('#part');
  });

  it('counts a buffer nobody has asked about when it is first marked read', () => {
    const first = say('#unasked');
    say('#unasked');
    bufferReads.setReadState(userId, netId, '#unasked', first);
    expect(stored('#unasked')).toMatchObject({ afterId: first, count: 1 });
  });

  it('a count for another pointer is never used', () => {
    const ids = [say('#stale'), say('#stale'), say('#stale')];
    expectExact('#stale');
    // The pointer moves without the count hearing of it (an import, a merge,
    // an older build after a rollback).
    db.prepare(
      `INSERT INTO buffer_reads (user_id, buffer_id, last_read_message_id) VALUES (?, ?, ?)
       ON CONFLICT(user_id, buffer_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
    ).run(userId, bufferId('#stale'), ids[1]);
    expect(stored('#stale').count).toBe(3);
    expect(messages.countUnread(netId, '#stale', pointer('#stale'))).toBe(1);
    expectExact('#stale');
  });

  it('a reader a tick behind the pointer does not cost a deep buffer its count', () => {
    unread.setUnreadWalkRowsForTests(4);
    const ids = Array.from({ length: 12 }, () => say('#behind'));
    bufferReads.setReadState(userId, netId, '#behind', ids[1]!);
    expectExact('#behind');
    const before = stored('#behind');
    // Asked about an older pointer: too long to count here, and not this
    // buffer's count to replace.
    expect(unread.readUnreadCount(bufferId('#behind'), ids[0]!)).toBeNull();
    expect(stored('#behind')).toEqual(before);
    expect(unread.nextFillBuffer()).toBeUndefined();
  });
});

describe('a buffer too deep to count in one statement', () => {
  it('is filled in chunks, and the capped walk serves until it is whole', () => {
    unread.setUnreadWalkRowsForTests(5);
    for (let i = 0; i < 23; i += 1) say('#deep', i % 4 === 0 ? { type: 'join' } : {});
    const id = bufferId('#deep');
    expect(unread.readUnreadCount(id, 0)).toBeNull();
    expect(stored('#deep')).toMatchObject({ afterId: 0, count: 0, fillId: 0 });
    expect(unread.nextFillBuffer()).toBe(id);
    // What the badge shows meanwhile.
    expect(messages.countUnread(netId, '#deep', 0)).toBe(truth('#deep').count);

    let steps = 0;
    let filled = 0;
    filler.onUnreadFilled(() => (filled += 1));
    while (unread.fillUnreadStep(id) === 'more') steps += 1;
    filler.onUnreadFilled(() => {});
    expect(steps).toBe(4);
    expect(filled).toBe(0);
    expectExact('#deep');
  });

  it('stays exact through inserts, deletes and moves that land mid-fill', () => {
    unread.setUnreadWalkRowsForTests(5);
    const ids = Array.from({ length: 30 }, () => say('#busy'));
    const other = [say('#other'), say('#other')];
    const id = bufferId('#busy');
    expect(unread.readUnreadCount(id, 0)).toBeNull();
    expect(unread.fillUnreadStep(id)).toBe('more');
    expect(unread.fillUnreadStep(id)).toBe('more');
    expect(stored('#busy')).toMatchObject({ count: 10, fillId: ids[9] });

    say('#busy'); // past the fill's place: walked later
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(ids[2]); // behind it: taken off now
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(ids[9]); // the place itself: walked
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(ids[20]); // ahead of it: never walked
    // #other's rows are older than the fill's place only if their ids are; they
    // were said after, so they land ahead of it.
    db.prepare(`UPDATE messages SET buffer_id = ? WHERE id IN (?, ?)`).run(id, ...other);
    db.prepare(`UPDATE messages SET buffer_id = ? WHERE id = ?`).run(bufferId('#other'), ids[4]);
    expect(stored('#busy')).toMatchObject({ count: 7, fillId: ids[9] });

    expectExact('#busy');
    expect(stored('#busy').count).toBe(29);
  });

  it('a screen read from a deep buffer moves the count without a fill', () => {
    unread.setUnreadWalkRowsForTests(5);
    const ids = Array.from({ length: 20 }, () => say('#scroll'));
    expectExact('#scroll');
    bufferReads.setReadState(userId, netId, '#scroll', ids[2]!);
    expect(stored('#scroll')).toMatchObject({ afterId: ids[2], count: 17, fillId: null });
    expect(unread.nextFillBuffer()).toBeUndefined();
    expectExact('#scroll');
  });

  it('a jump into the middle of a deep buffer is counted by the fill', () => {
    unread.setUnreadWalkRowsForTests(5);
    const ids = Array.from({ length: 30 }, () => say('#jump'));
    expectExact('#jump');
    bufferReads.setReadState(userId, netId, '#jump', ids[14]!);
    expect(stored('#jump')).toMatchObject({ afterId: ids[14], count: 0, fillId: ids[14] });
    expect(unread.nextFillBuffer()).toBe(bufferId('#jump'));
    expectExact('#jump');
    expect(stored('#jump').count).toBe(15);
  });

  it('a mark-read behind a fill takes its lines off and lets the fill carry on', () => {
    unread.setUnreadWalkRowsForTests(5);
    const ids = Array.from({ length: 30 }, () => say('#behindfill'));
    const id = bufferId('#behindfill');
    expect(unread.readUnreadCount(id, 0)).toBeNull();
    expect(unread.fillUnreadStep(id)).toBe('more');
    expect(unread.fillUnreadStep(id)).toBe('more');
    unread.resetUnreadFillQueueForTests();
    bufferReads.setReadState(userId, netId, '#behindfill', ids[2]!);
    expect(stored('#behindfill')).toMatchObject({ afterId: ids[2], count: 7, fillId: ids[9] });
    expect(unread.nextFillBuffer()).toBe(id);
    expectExact('#behindfill');
    expect(stored('#behindfill').count).toBe(27);
  });

  it('a mark-read past a fill starts the count again from the new pointer', () => {
    unread.setUnreadWalkRowsForTests(5);
    const ids = Array.from({ length: 30 }, () => say('#moved'));
    const id = bufferId('#moved');
    expect(unread.readUnreadCount(id, 0)).toBeNull();
    expect(unread.fillUnreadStep(id)).toBe('more');
    bufferReads.setReadState(userId, netId, '#moved', ids[9]!);
    expect(stored('#moved')).toMatchObject({ afterId: ids[9], count: 0, fillId: ids[9] });
    // …and reading to the end mid-fill ends it.
    bufferReads.setReadState(userId, netId, '#moved', ids[29]!);
    expect(stored('#moved')).toMatchObject({ afterId: ids[29], count: 0, fillId: null });
    expect(unread.fillUnreadStep(id)).toBe('idle');
    expectExact('#moved');
  });

  it('a fill a restart interrupted is picked up from the row', () => {
    unread.setUnreadWalkRowsForTests(5);
    for (let i = 0; i < 18; i += 1) say('#restart');
    const id = bufferId('#restart');
    expect(unread.readUnreadCount(id, 0)).toBeNull();
    expect(unread.fillUnreadStep(id)).toBe('more');
    unread.resetUnreadFillQueueForTests(); // the process went away
    expect(unread.nextFillBuffer()).toBeUndefined();
    expect(unread.queueInterruptedFills()).toBeGreaterThan(0);
    filler.drainUnreadFillsForTests();
    expect(stored('#restart')).toMatchObject({ count: 18, fillId: null });
    expectExact('#restart');
  });
});

describe('a soak: random traffic, every buffer checked after every step', () => {
  it('never disagrees with the slow count', () => {
    unread.setUnreadWalkRowsForTests(7);
    // Deterministic: a failure here must be the same failure on the next run.
    let state = 0x2f6e2b1;
    const rand = (n: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    const targets = ['#s1', '#s2', '#s3', `:server:${netId}`];
    const types = ['message', 'message', 'message', 'action', 'notice', 'join', 'quit', 'error'];
    for (const t of targets) say(t);
    const wrong: unknown[] = [];
    const idsIn = (t: string) =>
      (
        db.prepare(`SELECT id FROM messages WHERE buffer_id = ? ORDER BY id`).all(bufferId(t)) as {
          id: number;
        }[]
      ).map((r) => r.id);

    for (let step = 0; step < 600; step += 1) {
      const t = targets[rand(targets.length)]!;
      const op = rand(20);
      if (op < 11) {
        const reply = rand(5) === 0;
        say(t, {
          type: types[rand(types.length)]!,
          fromIgnored: rand(12) === 0,
          notable: rand(6) !== 0,
          ...(reply ? { replyRootMsgid: `root-${rand(3)}`, replyToSelf: rand(4) === 0 } : {}),
          ...(rand(9) === 0 ? { matchedRuleId: 1 } : {}),
        });
      } else if (op < 14) {
        const ids = idsIn(t);
        if (ids.length) bufferReads.setReadState(userId, netId, t, ids[rand(ids.length)]!);
      } else if (op < 16) {
        // Retention: the oldest few go, read or not.
        db.prepare(
          `DELETE FROM messages WHERE id IN (
             SELECT id FROM messages WHERE buffer_id = ? ORDER BY id LIMIT ?)`,
        ).run(bufferId(t), rand(4));
      } else if (op < 17) {
        const ids = idsIn(t);
        if (ids.length) db.prepare(`DELETE FROM messages WHERE id = ?`).run(ids[rand(ids.length)]);
      } else if (op < 18) {
        const to = targets[rand(3)]!;
        db.prepare(
          `UPDATE messages SET buffer_id = ? WHERE id IN (
             SELECT id FROM messages WHERE buffer_id = ? ORDER BY id DESC LIMIT ?)`,
        ).run(bufferId(to), bufferId(targets[rand(3)]!), rand(5));
      } else if (op < 19) {
        // A read, as a badge would make it; may start a fill.
        messages.countUnread(netId, t, pointer(t));
      } else {
        const next = unread.nextFillBuffer();
        if (next !== undefined) unread.fillUnreadStep(next);
      }
      // Whatever is stored and whole must be right, mid-fill or not.
      for (const each of targets) {
        const row = stored(each);
        if (row.count === null || row.fillId !== null) continue;
        const want = truth(each, row.afterId);
        if (want.count !== row.count || want.replies !== row.replies) {
          wrong.push({ step, each, want, got: { count: row.count, replies: row.replies } });
        }
      }
      if (wrong.length) break;
    }
    expect(wrong).toEqual([]);
    for (const t of targets) expectExact(t);
  });
});

describe('the triggers themselves', () => {
  it('are rebuilt when one is missing, and every count goes with them', () => {
    say('#rebuild');
    expectExact('#rebuild');
    db.exec(`DROP TRIGGER messages_unread_ai`);
    say('#rebuild'); // unseen
    expect(stored('#rebuild').count).toBe(1);
    dbIndex.ensureUnreadTriggersCurrent();
    expect(stored('#rebuild').count).toBeNull();
    expectExact('#rebuild');
    expect(stored('#rebuild').count).toBe(2);
    say('#rebuild');
    expect(stored('#rebuild').count).toBe(3);
    // Every boot runs this: with the triggers as written, it changes nothing.
    dbIndex.ensureUnreadTriggersCurrent();
    expect(stored('#rebuild').count).toBe(3);
  });

  it('leave an uncounted buffer alone', () => {
    say('#never');
    say('#never');
    expect(stored('#never')).toMatchObject({ count: null, fillId: null, afterId: 0 });
  });
});

describe('the filler', () => {
  it('runs a queued fill a chunk a turn, and says when the count is whole', async () => {
    unread.setUnreadWalkRowsForTests(5);
    for (let i = 0; i < 14; i += 1) say('#pumped');
    const id = bufferId('#pumped');
    const done: number[] = [];
    filler.onUnreadFilled((bufferId) => done.push(bufferId));
    filler.startUnreadFiller();
    try {
      expect(unread.readUnreadCount(id, 0)).toBeNull();
      // Nothing ran inside the read: the walk belongs to later turns.
      expect(stored('#pumped')).toMatchObject({ count: 0, fillId: 0 });
      await vi.waitFor(() => expect(done).toContain(id));
      expect(stored('#pumped')).toMatchObject({ count: 14, fillId: null });
    } finally {
      unread.setUnreadFillWaker(() => {});
      filler.onUnreadFilled(() => {});
    }
  });
});
