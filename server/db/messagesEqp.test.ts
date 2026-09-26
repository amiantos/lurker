// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// EXPLAIN QUERY PLAN assertions for the id-keyed message paths. The unread
// count being INDEX-ONLY is a load-bearing property (#469: reaching the count
// cap used to mean thousands of scattered rowid lookups per buffer per connect
// snapshot) — these tests pin the plan itself so an index or predicate edit
// that silently de-covers the query fails CI instead of shipping a
// spinning-disk regression.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-eqp-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;

function plan(sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(' | ');
}

beforeAll(async () => {
  ({ default: db } = await import('./index.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('unread-count path', () => {
  it('uses the covering per-buffer index (countUnreadRows shape)', () => {
    const detail = plan(
      `SELECT COUNT(*) FROM (
         SELECT 1 FROM messages
         WHERE buffer_id = 1 AND id > 0
           AND type IN ('message','action','notice')
           AND from_ignored = 0
         ORDER BY id DESC
         LIMIT 1000
       )`,
    );
    expect(detail).toMatch(/USING COVERING INDEX idx_messages_buf_unread/);
  });
});

describe('page and probe paths', () => {
  it('the backlog page walks the per-buffer index (listMessages shape)', () => {
    const detail = plan(`SELECT * FROM messages WHERE buffer_id = 1 ORDER BY id DESC LIMIT 50`);
    expect(detail).toMatch(/USING INDEX idx_messages_buf_unread/);
  });

  // The bouncer's attach playback, per buffer on every attach. A time-ordered
  // window here read and sorted the whole buffer (/code-review of
  // draft/event-playback).
  it('recent messages walk the per-buffer index without a sort (listRecentMessages shape)', () => {
    const detail = plan(
      `SELECT * FROM messages
        WHERE buffer_id = 1 AND type IN ('message', 'action', 'notice') AND mirrored = 0
          AND text IS NOT NULL AND text != ''
        ORDER BY id DESC LIMIT 50`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_buf_unread/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });

  it('the edge probe is an index seek (hasOlderThan shape)', () => {
    const detail = plan(`SELECT 1 FROM messages WHERE buffer_id = 1 AND id < 5 LIMIT 1`);
    expect(detail).toMatch(/USING COVERING INDEX idx_messages_buf_unread/);
  });
});

describe('repeat probe', () => {
  it('a repeated msgid is a seek on the msgid index (hasSameMessageWithMsgid shape)', () => {
    const detail = plan(
      `SELECT 1 FROM messages
       WHERE network_id = 1 AND msgid = 'm'
         AND +buffer_id = 1 AND type = 'message' AND nick IS 'n' AND text IS 't'
       LIMIT 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_msgid/);
  });

  it('a line without a msgid is looked for on the per-buffer index (hasRecentMessageLike shape)', () => {
    const detail = plan(
      `SELECT 1 FROM messages
       WHERE buffer_id = 1 AND type = 'message' AND nick IS 'n' AND text IS 't'
         AND time BETWEEN 'a' AND 'b' LIMIT 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_buf_unread/);
  });
});

describe('highlight-count path', () => {
  it('uses the partial matched index (countHighlightsNewer shape)', () => {
    const detail = plan(
      `SELECT COUNT(*) FROM messages
       WHERE buffer_id = 1 AND id > 0
         AND matched_rule_id IS NOT NULL
         AND from_ignored = 0
         AND notable = 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_matched_buf/);
  });

  // The reply half (#993): a probe of its own, so it walks its own partial
  // index rather than every unread row an OR with the rule half would cost.
  it('the reply half uses the partial reply index (countHighlightsNewer shape)', () => {
    const detail = plan(
      `SELECT COUNT(*) FROM messages
       WHERE buffer_id = 1 AND id > 0
         AND reply_to_self = 1 AND matched_rule_id IS NULL
         AND from_ignored = 0
         AND notable = 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_reply_self_buf/);
  });
});

describe('thread path', () => {
  // A thread for the forum view (#993): every reply naming the root, as one
  // range on the partial root index.
  it('reads a thread’s replies as one range on the root index', () => {
    const detail = plan(
      `SELECT id FROM messages WHERE buffer_id = 1 AND reply_root_msgid = 'x' ORDER BY id`,
    );
    expect(detail).toMatch(/USING (COVERING )?INDEX idx_messages_reply_root/);
  });

  it('finds a reply’s root by a seek on the msgid index (replyRootFor shape)', () => {
    const detail = plan(
      `SELECT reply_root_msgid FROM messages
       WHERE network_id = 1 AND msgid = 'x' AND +buffer_id = 1
         AND type IN ('message', 'action', 'notice')
       ORDER BY id DESC LIMIT 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_msgid/);
  });
});

describe('reply parent path', () => {
  // REPLY_COL / findReplyParent: one seek on the msgid index per reply row. The
  // `+` on buffer_id keeps the planner off the per-buffer index, which would
  // walk the whole buffer looking for one msgid.
  it('finds the parent by a seek on the msgid index', () => {
    const detail = plan(
      `SELECT p.id FROM messages p
       WHERE p.network_id = 1 AND p.msgid = 'x' AND +p.buffer_id = 1
         AND p.type IN ('message', 'action', 'notice') AND p.from_ignored = 0
       ORDER BY p.id DESC LIMIT 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_msgid/);
  });
});

// The searchMessages driving-filter shapes (SEARCH_FILTER_INDEX_PLAN in
// lurker-dev). searchMessages picks which predicate drives each filter-only
// search — these pin the planner's side of that contract. Two of them guard
// regressions that LOOK like simplifications: dropping idx_messages_net
// ("redundant with net_nick's prefix" — it isn't: no id-ordering through the
// nick column, so on:-only degrades to gather-and-sort), and removing the
// unary `+` on the buffer term (the planner then drives from:+in: through the
// buffer index, whose worst case walks a big buffer row-by-row for a nick
// that never spoke there).
describe('search filter paths', () => {
  const ROW_FILTERS = `m.type IN ('message','action','notice')
    AND m.from_ignored = 0 AND m.mirrored = 0`;

  // The network set arrives as a subquery over the caller's own rows, exactly
  // as searchMessages emits it — ownership-checked by construction (#798).
  const OWN_NETS = `(SELECT id FROM networks WHERE user_id = 1)`;
  const OWN_NET_1 = `(SELECT id FROM networks WHERE user_id = 1 AND id = 1)`;

  it('from:-only drives the nick index', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = 1 AND m.network_id IN ${OWN_NETS} AND ${ROW_FILTERS}
         AND m.nick = 'alice' COLLATE NOCASE
       ORDER BY m.id DESC LIMIT 51`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_net_nick/);
  });

  it('the before cursor rides the nick index range', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = 1 AND m.network_id IN ${OWN_NET_1} AND ${ROW_FILTERS}
         AND m.nick = 'alice' COLLATE NOCASE AND m.id < 100
       ORDER BY m.id DESC LIMIT 51`,
    );
    expect(detail).toMatch(
      /USING INDEX idx_messages_net_nick \(network_id=\? AND nick=\? AND id<\?\)/,
    );
  });

  it('from:+in: still drives the nick index (the +buffer demotion)', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = 1 AND m.network_id IN ${OWN_NET_1} AND ${ROW_FILTERS}
         AND m.nick = 'alice' COLLATE NOCASE AND +m.buffer_id IN (7)
       ORDER BY m.id DESC LIMIT 51`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_net_nick/);
  });

  it('in:+on: drives the buffer index (no network predicate emitted)', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = 1 AND ${ROW_FILTERS} AND m.buffer_id IN (7)
       ORDER BY m.id DESC LIMIT 51`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_buf_unread/);
  });

  it('on:-only drives the network index, ordered, no sort', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = 1 AND m.network_id = 1 AND ${ROW_FILTERS}
       ORDER BY m.id DESC LIMIT 51`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_net\b/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });

  it('free text keeps FTS driving and streams in rowid order, no sort', () => {
    const detail = plan(
      `SELECT m.* FROM messages m JOIN networks n ON n.id = m.network_id
       JOIN messages_fts ON messages_fts.rowid = m.id
       WHERE n.user_id = 1 AND messages_fts MATCH '"hello"' AND ${ROW_FILTERS}
         AND m.nick = 'alice' COLLATE NOCASE
       ORDER BY messages_fts.rowid DESC LIMIT 51`,
    );
    expect(detail).toMatch(/SCAN messages_fts/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });
});

// The retention sweep's two statements (db/retention.ts). Count-based
// retention was chosen partly BECAUSE these ride idx_messages_buf_unread with
// no new index; these pins are what make that a property rather than a hope.
// The bookmark-exemption probe must stay a seek on the (user_id, message_id)
// primary key — dropping the user_id term demotes it to a scan of the whole
// bookmarks table per candidate row.
describe('retention prune paths', () => {
  it('the boundary probe walks the covering per-buffer index', () => {
    const detail = plan(
      `SELECT id FROM messages WHERE buffer_id = 1 ORDER BY id DESC LIMIT 1 OFFSET 999`,
    );
    expect(detail).toMatch(/USING COVERING INDEX idx_messages_buf_unread/);
  });

  it('the delete subselect stays covered, with a seekable bookmark probe', () => {
    const detail = plan(
      `DELETE FROM messages WHERE id IN (
         SELECT m.id FROM messages m
          WHERE m.buffer_id = 1 AND m.id < 500
            AND NOT EXISTS (
              SELECT 1 FROM user_bookmarks ub
               WHERE ub.user_id = 1 AND ub.message_id = m.id
            )
          LIMIT 500
       )`,
    );
    expect(detail).toMatch(
      /USING COVERING INDEX idx_messages_buf_unread \(buffer_id=\? AND id<\?\)/,
    );
    expect(detail).toMatch(
      /USING COVERING INDEX sqlite_autoindex_user_bookmarks_1 \(user_id=\? AND message_id=\?\)/,
    );
  });
});

// The noise clock's access path (db/retention.ts deleteNoiseBatch). Two pins:
// the partial index must drive the time-range scan (SQLite only considers it
// when the query's type list implies the index predicate — both are generated
// from shared EARLY_PRUNE_TYPES, so they match by construction), and the LIVE
// index's DDL must still contain the generated list — someone widening the
// shared set without migrating the index would otherwise silently stop
// covering the new type.
describe('noise-clock paths', () => {
  let earlyPruneSql: string;
  beforeAll(async () => {
    ({ EARLY_PRUNE_TYPES_SQL: earlyPruneSql } = await import('./index.js'));
  });

  it('the noise delete subselect drives the partial time index', () => {
    const detail = plan(
      `SELECT m.id FROM messages m INDEXED BY idx_messages_noise_time
        JOIN buffers b ON b.id = m.buffer_id
        WHERE m.type IN (${earlyPruneSql})
          AND m.time < '2026-01-01T00:00:00.000Z'
          AND b.user_id = 1
          AND NOT EXISTS (
            SELECT 1 FROM user_bookmarks ub
             WHERE ub.user_id = 1 AND ub.message_id = m.id
          )
        LIMIT 500`,
    );
    expect(detail).toMatch(/USING (COVERING )?INDEX idx_messages_noise_time \(time<\?\)/);
  });

  it('a stale index predicate is rebuilt by the boot self-heal, not left to crash', async () => {
    // Simulate a deployed DB whose index predates an EARLY_PRUNE_TYPES edit:
    // without the heal, db/retention.ts's INDEXED BY statements fail to
    // prepare at module load — a boot crash-loop a fresh-DB CI run can never
    // reproduce, which is exactly why this exercises the rebuild path
    // directly instead of asserting the (always-fresh) index matches.
    const { ensureNoiseIndexCurrent } = await import('./index.js');
    db.exec(`DROP INDEX idx_messages_noise_time`);
    db.exec(
      `CREATE INDEX idx_messages_noise_time ON messages(time, buffer_id)
        WHERE type IN ('join', 'quit')`,
    );
    ensureNoiseIndexCurrent();
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get('idx_messages_noise_time') as { sql: string } | undefined;
    expect(row?.sql).toContain(`(${earlyPruneSql})`);
  });
});

// MARKREAD maps a read pointer (an id) to a time and back (bouncer.ts). Both
// lookups run on a client's command, and messages.time is unindexed, so each
// step has to be a seek on the per-buffer id index, never a walk or a sort.
describe('read-marker paths', () => {
  it('each bisection step is an index seek (newestIdAtOrBefore shape)', () => {
    const detail = plan(
      `SELECT id, time FROM messages
       WHERE buffer_id = 1 AND id > 0 AND id <= 100
       ORDER BY id DESC LIMIT 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_buf_unread/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });

  it('the walk after the bisection stays on the per-buffer index (newestIdAtOrBefore shape)', () => {
    const detail = plan(
      `SELECT id FROM messages
       WHERE buffer_id = 1 AND id > 0 AND id <= 100 AND time <= '2026-01-01T00:00:00.000Z'
       ORDER BY id DESC LIMIT 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_buf_unread/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });

  it("a read pointer's time is an index seek (readMarkerTime shape)", () => {
    const detail = plan(
      `SELECT time FROM messages WHERE buffer_id = 1 AND id <= 5 ORDER BY id DESC LIMIT 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_buf_unread/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });
});
