// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// renameBuffer: moving a buffer across every table that stores its name.
//
// The failure this guards against is silent: a table missed by the rename leaves
// the user's draft, pin, or read pointer stranded under a name nothing looks up
// again. So the central test isn't "did messages move" — it's the registry
// coverage test, which walks BUFFER_KEYED_TABLES and fails if any live entry is
// neither handled nor explicitly declared unhandled.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type DatabaseType from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-rename-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: DatabaseType.Database;
let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let insertMessage: typeof import('./messages.js').insertMessage;
let renameBuffer: typeof import('./renameBuffer.js').renameBuffer;
let estimateCost: typeof import('./renameBuffer.js').estimateCost;
let rewriteChannelList: typeof import('./renameBuffer.js').rewriteChannelList;
let hasRenameHandler: typeof import('./renameBuffer.js').hasRenameHandler;
let unhandledRenameTables: typeof import('./renameBuffer.js').unhandledRenameTables;
let CURRENT_BUFFER_KEYED_TABLES: typeof import('./bufferKeyedTables.js').CURRENT_BUFFER_KEYED_TABLES;
let userId: number;

const T = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ insertMessage } = await import('./messages.js'));
  ({ renameBuffer, estimateCost, rewriteChannelList, hasRenameHandler, unhandledRenameTables } =
    await import('./renameBuffer.js'));
  ({ CURRENT_BUFFER_KEYED_TABLES } = await import('./bufferKeyedTables.js'));
  userId = createUser('rename-user').id;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function freshNetwork(): number {
  return createNetwork(userId, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' })!.id;
}
function addBuffer(networkId: number, target: string, state: 'open' | 'closed' = 'open'): void {
  db.prepare(
    `INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state)
     VALUES (?, ?, ?, ?, 'channel', ?)`,
  ).run(userId, networkId, target, target.toLowerCase(), state);
}
function seed(networkId: number, target: string, count: number): void {
  for (let i = 0; i < count; i++)
    insertMessage({ networkId, target, time: T, type: 'message', nick: 'x', text: 'hi' });
}
function messageCount(networkId: number, target: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE network_id = ? AND target = ?`)
      .get(networkId, target) as { n: number }
  ).n;
}
function bufferTargets(networkId: number): Array<{ target: string; folded: string }> {
  return db
    .prepare(
      `SELECT target, target_folded AS folded FROM buffers
        WHERE user_id = ? AND network_id = ? ORDER BY target_folded`,
    )
    .all(userId, networkId) as Array<{ target: string; folded: string }>;
}

describe('registry coverage', () => {
  it('handles or explicitly excuses every live buffer-keyed table', () => {
    // The test that makes the registry worth having: adding a buffer-keyed table
    // and forgetting renameBuffer is a failure here, not a stranded row in prod.
    const unexplained = CURRENT_BUFFER_KEYED_TABLES.filter(
      (t) => !hasRenameHandler(t.table) && !unhandledRenameTables()[t.table],
    ).map((t) => t.table);
    expect(unexplained).toEqual([]);
  });

  it('excuses only the two list-valued tables, with reasons', () => {
    expect(Object.keys(unhandledRenameTables()).toSorted()).toEqual([
      'highlight_rules',
      'ignored_masks',
    ]);
    for (const reason of Object.values(unhandledRenameTables())) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

describe('a plain rename', () => {
  it('moves history and the registry row together', () => {
    const net = freshNetwork();
    addBuffer(net, '#old');
    seed(net, '#old', 5);

    const res = renameBuffer(userId, net, '#old', '#new');

    expect(res.renamed).toBe(true);
    expect(res.merged).toBe(false);
    expect(messageCount(net, '#old')).toBe(0);
    expect(messageCount(net, '#new')).toBe(5);
    expect(bufferTargets(net)).toEqual([{ target: '#new', folded: '#new' }]);
  });

  it('resolves the caller casing against the registry before matching', () => {
    // The DM case: a NICK event's old nick needn't match our stored casing. If
    // this resolved wrong, the exact-match UPDATEs would silently move nothing.
    const net = freshNetwork();
    addBuffer(net, 'Bob');
    seed(net, 'Bob', 3);

    const res = renameBuffer(userId, net, 'bOb', 'Robert');

    expect(res.resolvedFrom).toBe('Bob');
    expect(messageCount(net, 'Robert')).toBe(3);
    expect(bufferTargets(net)).toEqual([{ target: 'Robert', folded: 'robert' }]);
  });

  it('is a no-op when nothing references the old name', () => {
    const net = freshNetwork();
    const res = renameBuffer(userId, net, '#ghost', '#other');
    expect(res.renamed).toBe(false);
    expect(res.rowsAffected).toEqual({});
  });

  it('is a no-op when from and to are identical', () => {
    const net = freshNetwork();
    addBuffer(net, '#same');
    seed(net, '#same', 2);
    expect(renameBuffer(userId, net, '#same', '#same').renamed).toBe(false);
    expect(messageCount(net, '#same')).toBe(2);
  });
});

describe('a case-only rename', () => {
  it('rewrites in place rather than colliding with itself', () => {
    // folded key unchanged, so source and destination are the SAME row. Treating
    // this as a merge would delete the row it just updated.
    const net = freshNetwork();
    addBuffer(net, '#Foo');
    seed(net, '#Foo', 4);

    const res = renameBuffer(userId, net, '#Foo', '#foo');

    expect(res.merged).toBe(false);
    expect(res.renamed).toBe(true);
    expect(bufferTargets(net)).toEqual([{ target: '#foo', folded: '#foo' }]);
    expect(messageCount(net, '#foo')).toBe(4);
  });
});

describe('merging into an existing destination', () => {
  it('keeps one buffer row and moves all history onto it', () => {
    const net = freshNetwork();
    addBuffer(net, 'bob');
    addBuffer(net, 'robert');
    seed(net, 'bob', 3);
    seed(net, 'robert', 2);

    const res = renameBuffer(userId, net, 'bob', 'robert');

    expect(res.merged).toBe(true);
    expect(bufferTargets(net)).toEqual([{ target: 'robert', folded: 'robert' }]);
    expect(messageCount(net, 'robert')).toBe(5);
    expect(messageCount(net, 'bob')).toBe(0);
  });

  it('reopens a closed destination rather than hiding the merged history', () => {
    const net = freshNetwork();
    addBuffer(net, 'bob', 'open');
    addBuffer(net, 'robert', 'closed');
    seed(net, 'bob', 3);

    renameBuffer(userId, net, 'bob', 'robert');

    const state = db
      .prepare(`SELECT state FROM buffers WHERE user_id = ? AND network_id = ? AND target = ?`)
      .get(userId, net, 'robert') as { state: string };
    expect(state.state).toBe('open');
  });

  it('keeps the furthest read pointer and the furthest clear marker', () => {
    const net = freshNetwork();
    addBuffer(net, 'bob');
    addBuffer(net, 'robert');
    db.prepare(
      `INSERT INTO buffer_reads
         (user_id, network_id, target, last_read_message_id, cleared_before_message_id, cleared_at)
       VALUES (?, ?, 'bob', 100, 50, 'A'), (?, ?, 'robert', 40, 90, 'B')`,
    ).run(userId, net, userId, net);

    renameBuffer(userId, net, 'bob', 'robert');

    const row = db
      .prepare(
        `SELECT last_read_message_id AS lastRead, cleared_before_message_id AS clearedBefore,
                cleared_at AS clearedAt
           FROM buffer_reads WHERE user_id = ? AND network_id = ?`,
      )
      .all(userId, net) as Array<{ lastRead: number; clearedBefore: number; clearedAt: string }>;
    expect(row).toHaveLength(1);
    // Each dimension takes its own maximum — a merge may neither resurrect read
    // messages nor un-clear cleared ones.
    expect(row[0].lastRead).toBe(100);
    expect(row[0].clearedBefore).toBe(90);
    expect(row[0].clearedAt).toBe('B');
  });

  it('drops the colliding draft and keeps the destination its own', () => {
    const net = freshNetwork();
    addBuffer(net, 'bob');
    addBuffer(net, 'robert');
    db.prepare(
      `INSERT INTO user_drafts (user_id, network_id, target, body)
       VALUES (?, ?, 'bob', 'from-source'), (?, ?, 'robert', 'from-dest')`,
    ).run(userId, net, userId, net);

    renameBuffer(userId, net, 'bob', 'robert');

    const drafts = db
      .prepare(`SELECT target, body FROM user_drafts WHERE user_id = ? AND network_id = ?`)
      .all(userId, net) as Array<{ target: string; body: string }>;
    expect(drafts).toEqual([{ target: 'robert', body: 'from-dest' }]);
  });

  it('leaves pin positions dense after a collision drops one', () => {
    const net = freshNetwork();
    for (const [i, t] of ['#a', '#b', '#c'].entries()) {
      addBuffer(net, t);
      db.prepare(
        `INSERT INTO pinned_buffers (user_id, network_id, target, position) VALUES (?, ?, ?, ?)`,
      ).run(userId, net, t, i);
    }

    // '#a' merges into '#c', which is already pinned — one pin disappears, and
    // reorderPins assumes 0..n-1, so the gap has to close.
    renameBuffer(userId, net, '#a', '#c');

    const positions = (
      db
        .prepare(
          `SELECT target, position FROM pinned_buffers
            WHERE user_id = ? AND network_id = ? ORDER BY position`,
        )
        .all(userId, net) as Array<{ target: string; position: number }>
    ).map((r) => r.position);
    expect(positions).toEqual([0, 1]);
  });
});

describe('rules that still name the old buffer', () => {
  it('reports them instead of rewriting or ignoring them', () => {
    const net = freshNetwork();
    addBuffer(net, '#old');
    seed(net, '#old', 1);
    db.prepare(
      `INSERT INTO ignored_masks (user_id, network_id, mask, channels, pattern_kind, levels)
       VALUES (?, ?, 'spammer', '#old', 'substr', 'ALL')`,
    ).run(userId, net);

    const res = renameBuffer(userId, net, '#old', '#new');

    expect(res.renamed).toBe(true);
    expect(res.stillReferencing.ignored_masks).toBe(1);
    // Untouched, deliberately — see UNHANDLED_TABLES.
    const rule = db.prepare(`SELECT channels FROM ignored_masks WHERE user_id = ?`).get(userId) as {
      channels: string;
    };
    expect(rule.channels).toBe('#old');
  });
});

describe('rewriteChannelList', () => {
  it('replaces a literal entry and leaves the rest alone', () => {
    expect(rewriteChannelList('#old,#keep', '#old', '#new')).toBe('#new,#keep');
  });

  it('never rewrites a glob', () => {
    // '#old*' covers more than this buffer; rewriting it would change which
    // channels the rule matches.
    expect(rewriteChannelList('#old*,#old', '#old', '#new')).toBe('#old*,#new');
  });

  it('folds case on both sides', () => {
    expect(rewriteChannelList('#OLD', '#oLd', '#New')).toBe('#new');
  });

  it('collapses a rename onto a name the list already had', () => {
    expect(rewriteChannelList('#old,#new', '#old', '#new')).toBe('#new');
  });

  it('returns null for an empty or emptied list', () => {
    expect(rewriteChannelList(null, '#old', '#new')).toBeNull();
    expect(rewriteChannelList('  ', '#old', '#new')).toBeNull();
  });
});

describe('estimateCost', () => {
  it('counts the rows a rename would move, before moving them', () => {
    const net = freshNetwork();
    addBuffer(net, '#big');
    seed(net, '#big', 12);

    const cost = estimateCost(userId, net, '#big');

    expect(cost.rowsByTable.messages).toBe(12);
    expect(cost.rowsByTable.buffers).toBe(1);
    expect(cost.total).toBe(13);
    // Purely a pre-flight — nothing moved.
    expect(messageCount(net, '#big')).toBe(12);
  });
});
