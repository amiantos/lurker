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
         AND +buffer_id = 1 AND type = 'message' AND nick IS 'n' AND (text IS 't' OR redacted_at IS NOT NULL)
       LIMIT 1`,
    );
    expect(detail).toMatch(/USING INDEX idx_messages_msgid/);
  });

  it('a line without a msgid reads only the buffer tail (the real hasRecentMessageLike statement)', async () => {
    const { HAS_LIKE_SQL } = await import('./messages.js');
    // The tail subquery walks the per-buffer index newest-first under the id
    // bound and the LIMIT; nothing sorts, and the rest of the buffer is never read.
    const detail = (
      db.prepare(`EXPLAIN QUERY PLAN ${HAS_LIKE_SQL}`).all({
        bufferId: 1,
        maxId: 100,
        tailRows: 1000,
        type: 'message',
        nick: 'n',
        text: 't',
        lo: 'a',
        hi: 'b',
      }) as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(detail).toMatch(
      /USING (COVERING )?INDEX idx_messages_buf_unread \(buffer_id=\? AND id<\?\)/,
    );
    expect(detail).not.toMatch(/TEMP B-TREE/);
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
    expect(detail).toMatch(/USING COVERING INDEX idx_messages_matched_buf/);
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
    expect(detail).toMatch(/USING COVERING INDEX idx_messages_reply_self_buf/);
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

// The highlights / activity feed (searchMessages with `matched`, no free
// text). Pinned on the statement searchMessagesSql actually builds, not a
// copy: #1070 was "all my highlights" walking every message on every one of
// 17 networks through idx_messages_net and sorting the lot — a 139s stall
// that expired every IRC ping timer. The contract: the two partial indexes
// supply the id list, the outer query is a rowid (or network+id) seek per
// listed id, and nothing sorts, so the LIMIT bounds the table fetches.
describe('highlight feed paths', () => {
  let searchMessagesSql: typeof import('./messages.js').searchMessagesSql;
  let userId: number;
  let netId: number;
  beforeAll(async () => {
    ({ searchMessagesSql } = await import('./messages.js'));
    const { createUser } = await import('./users.js');
    const { createNetwork } = await import('./networks.js');
    const { insertMessage } = await import('./messages.js');
    userId = createUser('eqp-hl').id;
    netId = createNetwork(userId, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'me' })!.id;
    const net2 = createNetwork(userId, {
      name: 'n2',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    // Real buffers — the same channel on both networks — so in: resolves to
    // ids instead of short-circuiting.
    for (const networkId of [netId, net2.id]) {
      insertMessage({
        networkId,
        target: '#eqp',
        time: new Date().toISOString(),
        type: 'message',
        nick: 'bob',
        text: 'hi',
        self: false,
        matchedRuleId: 1,
      });
    }
  });

  function searchPlan(opts: Parameters<typeof searchMessagesSql>[1]): string {
    const built = searchMessagesSql(userId, opts);
    if (!built) throw new Error('statement short-circuited');
    return (
      db.prepare(`EXPLAIN QUERY PLAN ${built.sql}`).all(...built.params) as Array<{
        detail: string;
      }>
    )
      .map((r) => r.detail)
      .join(' | ');
  }

  const highlightPlan = (opts: Parameters<typeof searchMessagesSql>[1]) =>
    searchPlan({ matched: true, ...opts });

  // Every shape: both partial indexes feed the list, each SEEKING the caller's
  // buffers (never a scan of every user's highlights), the page is seeks, no
  // sort.
  function expectDriven(detail: string) {
    expect(detail).toMatch(/LIST SUBQUERY/);
    expect(detail).toMatch(
      /SEARCH messages USING COVERING INDEX idx_messages_matched_buf \(buffer_id=\?/,
    );
    expect(detail).toMatch(
      /SEARCH messages USING COVERING INDEX idx_messages_reply_self_buf \(buffer_id=\?/,
    );
    expect(detail).not.toMatch(/SCAN messages\b/);
    expect(detail).toMatch(
      /SEARCH m USING (INTEGER PRIMARY KEY \(rowid=\?\)|INDEX idx_messages_net \(network_id=\? AND id=\?)/,
    );
    expect(detail).not.toMatch(/TEMP B-TREE/);
    expect(detail).not.toMatch(/SCAN m\b/);
  }

  it('all my highlights never touches idx_messages_net', () => {
    const detail = highlightPlan({});
    expectDriven(detail);
    expect(detail).not.toMatch(/idx_messages_net/);
  });

  it('the cursor and in: become seeks inside both halves', () => {
    const detail = highlightPlan({ target: '#eqp', networkId: netId, before: 100 });
    expectDriven(detail);
    expect(detail).toMatch(/idx_messages_matched_buf \(buffer_id=\? AND id<\?\)/);
    expect(detail).toMatch(/idx_messages_reply_self_buf \(buffer_id=\? AND id<\?\)/);
  });

  it('without in:, the halves seek the caller’s own buffers, cursor included', () => {
    const detail = highlightPlan({ before: 100 });
    expectDriven(detail);
    expect(detail).toMatch(/idx_messages_matched_buf \(buffer_id=\? AND id<\?\)/);
    expect(detail).toMatch(/idx_messages_reply_self_buf \(buffer_id=\? AND id<\?\)/);
    // The buffer set comes from the caller's own networks, index-only.
    expect(detail).toMatch(/SEARCH n USING COVERING INDEX idx_networks_user \(user_id=\?\)/);
  });

  it('on: and from: stay row checks over the listed ids', () => {
    for (const opts of [
      { networkId: netId },
      { nick: 'alice' },
      { nicks: ['alice', 'bob'], networkId: netId },
    ]) {
      const detail = highlightPlan(opts);
      expectDriven(detail);
      // Neither a bare network walk nor the nick index takes over the page.
      expect(detail).not.toMatch(/idx_messages_net \(network_id=\?\)|idx_messages_net_nick/);
    }
  });

  // in: alone, the channel held on two networks: each buffer pages itself
  // through the per-buffer index and the union is seeked by rowid — never the
  // gather-and-sort of both buffers' whole history a multi-value IN produced.
  it('in: on several networks pages each buffer, no sort', () => {
    const detail = searchPlan({ target: '#eqp' });
    expect(detail.match(/idx_messages_buf_unread \(buffer_id=\?\)/g)).toHaveLength(2);
    expect(detail).toMatch(/SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });

  // The plan can't show a LIMIT, and a half without one would plan the same
  // while walking each buffer's whole history: pin it in the statement.
  it('in: on several networks LIMITs every buffer’s contribution', () => {
    const built = searchMessagesSql(userId, { target: '#eqp' });
    expect(built!.sql.match(/ORDER BY h\.id DESC LIMIT \?\)/g)).toHaveLength(2);
  });

  it('in: on several networks seeks the cursor inside each buffer', () => {
    const detail = searchPlan({ target: '#eqp', before: 100 });
    expect(detail.match(/idx_messages_buf_unread \(buffer_id=\? AND id<\?\)/g)).toHaveLength(2);
    expect(detail).not.toMatch(/TEMP B-TREE/);
  });

  it('in:+on: still streams the one buffer', () => {
    const detail = searchPlan({ target: '#eqp', networkId: netId });
    expect(detail).toMatch(/SEARCH m USING INDEX idx_messages_buf_unread \(buffer_id=\?\)/);
    expect(detail).not.toMatch(/TEMP B-TREE|LIST SUBQUERY/);
  });

  it('free text keeps FTS driving, highlights as a row filter', () => {
    const detail = highlightPlan({ query: 'hello' });
    expect(detail).toMatch(/SCAN messages_fts/);
    expect(detail).not.toMatch(/LIST SUBQUERY/);
    // withReplyCol's outer ORDER BY re-sorts the LIMITed page (SQLite can't
    // see that the FTS rowid is the page id); the page itself streams unsorted.
    expect(detail.split('SCAN page')[0]).not.toMatch(/TEMP B-TREE/);
  });
});

// Every feed statement, every filter combination. #1070 was a shape nobody
// had hand-picked (a bare in: resolving on two networks; all-my-highlights),
// so the pins above are joined by a grid: each statement builder is driven
// through the full cross product of its filters and each plan is checked by
// one rule — the page itself (before withReplyCol's re-sort of the LIMITed
// page) never sorts and never scans a base table. Those are the two shapes
// whose cost scales with history rather than with the page.
describe('feed plan grid', () => {
  let searchMessagesSql: typeof import('./messages.js').searchMessagesSql;
  let listReactionsToUserSql: typeof import('./reactions.js').listReactionsToUserSql;
  let listBookmarksForUserSql: typeof import('./bookmarks.js').listBookmarksForUserSql;
  let userId: number;
  let netId: number;
  beforeAll(async () => {
    ({ searchMessagesSql } = await import('./messages.js'));
    ({ listReactionsToUserSql } = await import('./reactions.js'));
    ({ listBookmarksForUserSql } = await import('./bookmarks.js'));
    const { createUser } = await import('./users.js');
    const { createNetwork } = await import('./networks.js');
    const { insertMessage } = await import('./messages.js');
    userId = createUser('eqp-grid').id;
    // The channel on two networks, so in: resolves to several buffers — the
    // shape a single-network fixture can never produce.
    const nets = ['g1', 'g2'].map(
      (name) => createNetwork(userId, { name, host: 'h', port: 6697, tls: true, nick: 'me' })!.id,
    );
    netId = nets[0];
    for (const networkId of nets) {
      insertMessage({
        networkId,
        target: '#grid',
        time: new Date().toISOString(),
        type: 'message',
        nick: 'bob',
        text: 'hi',
        self: false,
      });
    }
  });

  // The lines of the page's own plan: everything before withReplyCol's
  // `SCAN page`, whose ORDER BY re-sorts at most LIMIT rows.
  function pagePlan(sql: string, params: unknown[]): string[] {
    const rows = (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>
    ).map((r) => r.detail);
    const cut = rows.indexOf('SCAN page');
    return cut >= 0 ? rows.slice(0, cut) : rows;
  }
  // A sort, or a walk of a base table that isn't an index seek, is the
  // history-shaped cost. `SCAN messages_fts` is FTS streaming matches; `SCAN
  // (subquery-N)` is a co-routine half.
  const offending = (lines: string[]) =>
    lines.filter(
      (d) =>
        /TEMP B-TREE/.test(d) ||
        /^SCAN (m|h|r|b|n|messages|message_reactions|user_bookmarks|networks|buffers)\b/.test(d),
    );
  // Every subset of a filter set, as option objects.
  function grid<T extends Record<string, unknown>>(dims: T): Partial<T>[] {
    const keys = Object.keys(dims) as (keyof T)[];
    const out: Partial<T>[] = [];
    for (let mask = 0; mask < 1 << keys.length; mask++) {
      const opts: Partial<T> = {};
      keys.forEach((k, i) => {
        if (mask & (1 << i)) opts[k] = dims[k];
      });
      out.push(opts);
    }
    return out;
  }

  // Not only "no sort, no scan": a weak plan can pass that (a nick walk
  // demoted to its network prefix, a cursor that FTS no longer ranges, a
  // half with no LIMIT). Each shape also has to show the SEEK its driver
  // owes it — with the cursor inside the seek's range when there is one —
  // and, when a list of halves drives, one LIMIT per half in the statement.
  const seek = (index: string, prefix: string, cursor: string | null) =>
    new RegExp(`${index} \\(${prefix}${cursor ? ` AND ${cursor}` : ''}\\)`, 'g');
  const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
  // A half's own LIMIT (the page's is never followed by `)` in this form).
  const halfLimits = (sql: string, alias: string) =>
    count(sql, new RegExp(`ORDER BY ${alias}\\.id DESC LIMIT \\?\\)`, 'g'));

  it('a text search over a scope that holds nothing is not run at all', () => {
    // Not the caller's network, or a channel none of their networks holds:
    // there are no rows to find, and on the word alone the statement would
    // walk every hit on the instance to return none (#1302).
    const foreign = netId + 1000;
    expect(searchMessagesSql(userId, { query: 'hello', networkId: foreign })).toBeNull();
    expect(searchMessagesSql(userId, { query: 'hello', target: '#nowhere' })).toBeNull();
    expect(
      searchMessagesSql(userId, { query: 'hello', target: '#grid', networkId: foreign }),
    ).toBeNull();
    // Without text those shapes keep their statement (and match nothing).
    expect(searchMessagesSql(userId, { networkId: foreign })).not.toBeNull();
  });

  it('search: 64 filter combinations, each driven by its own seek', () => {
    let checked = 0;
    for (const opts of grid({
      query: 'hello',
      nick: 'alice',
      target: '#grid',
      networkId: netId,
      matched: true,
      before: 100,
    })) {
      const built = searchMessagesSql(userId, opts);
      if (!built) continue; // the empty filter set, which never runs
      checked += 1;
      const lines = pagePlan(built.sql, built.params);
      const plan = lines.join(' | ');
      const id = opts.before ? 'id<\\?' : null;
      // The buffers in: resolves to: both networks', or on:'s one.
      const buffers = opts.networkId ? 1 : 2;
      // `second`: a companion the shape also owes, exactly once — the reply
      // half of a highlight read, FTS matched once (never re-probed per row),
      // the page's rowid seek when a list drives.
      const rowidPage = /SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\)/g;
      let expected: { driver: RegExp; seeks: number; halves: number | null; second: RegExp };
      if (opts.query) {
        // FTS streams, the cursor as a native rowid range (`<`). `M3` is a
        // MATCH on the three-column index (text, buffer_id, network_id).
        expected = {
          driver: new RegExp(
            `SCAN messages_fts VIRTUAL TABLE INDEX \\d+:M3${opts.before ? '<' : ''}(?: |$)`,
            'g',
          ),
          seeks: 1,
          halves: null,
          second: /SCAN messages_fts/g,
        };
      } else if (opts.matched) {
        // Both stamps, each seeked by buffer; no LIMIT inside (a partial
        // index holds only highlights, so the probe is the bound).
        expected = {
          driver: seek('COVERING INDEX idx_messages_matched_buf', 'buffer_id=\\?', id),
          seeks: 1,
          halves: null,
          second: seek('idx_messages_reply_self_buf', 'buffer_id=\\?', id),
        };
      } else if (opts.nick) {
        const halves = opts.target ? buffers : opts.networkId ? 1 : 2;
        expected = {
          driver: seek('idx_messages_net_nick', 'network_id=\\? AND nick=\\?', id),
          seeks: halves,
          halves,
          second: rowidPage,
        };
      } else if (opts.target) {
        expected = {
          driver: seek('idx_messages_buf_unread', 'buffer_id=\\?', id),
          seeks: buffers,
          halves: buffers > 1 ? buffers : null,
          second: buffers > 1 ? rowidPage : /SEARCH n USING INTEGER PRIMARY KEY/g,
        };
      } else {
        expected = {
          driver: seek('idx_messages_net', 'network_id=\\?', id),
          seeks: 1,
          halves: null,
          second: /SEARCH n USING INTEGER PRIMARY KEY/g,
        };
      }
      // The MATCH names where to look as well as the word (#1302): in:'s
      // buffers, else the caller's networks. No plan line shows a missing
      // scope term, and no result does either — only the cost.
      const scope = opts.target
        ? `buffer_id:\\("\\d+"${buffers > 1 ? ' OR "\\d+"' : ''}\\)`
        : `network_id:\\("\\d+"${opts.networkId ? '' : ' OR "\\d+"'}\\)`;
      const wanted = opts.query ? new RegExp(`^text:\\("hello"\\) AND ${scope}$`) : /^none$/;
      const matchParam =
        built.params.find((p) => typeof p === 'string' && p.startsWith('text:')) ?? 'none';
      expect({ opts, match: matchParam }).toEqual({ opts, match: expect.stringMatching(wanted) });
      expect({ opts, bad: offending(lines) }).toEqual({ opts, bad: [] });
      expect({ opts, seeks: count(plan, expected.driver) }).toEqual({
        opts,
        seeks: expected.seeks,
      });
      expect({ opts, second: count(plan, expected.second) }).toEqual({ opts, second: 1 });
      expect({
        opts,
        halves: expected.halves === null ? null : halfLimits(built.sql, 'h'),
      }).toEqual({
        opts,
        halves: expected.halves,
      });
    }
    expect(checked).toBe(62);
  });

  it('search: several from: nicks, one LIMITed seek per (network, nick)', () => {
    const shapes: [Parameters<typeof searchMessagesSql>[1], number][] = [
      [{ nicks: ['alice', 'bob'] }, 4],
      [{ nicks: ['alice', 'bob'], networkId: netId }, 2],
      [{ nicks: ['alice', 'bob'], target: '#grid', before: 100 }, 4],
    ];
    for (const [opts, halves] of shapes) {
      const built = searchMessagesSql(userId, opts)!;
      const plan = pagePlan(built.sql, built.params).join(' | ');
      expect({ opts, bad: offending(plan.split(' | ')) }).toEqual({ opts, bad: [] });
      const cursor = opts?.before ? 'id<\\?' : null;
      expect({
        opts,
        seeks: count(plan, seek('idx_messages_net_nick', 'network_id=\\? AND nick=\\?', cursor)),
      }).toEqual({
        opts,
        seeks: halves,
      });
      expect({ opts, halves: halfLimits(built.sql, 'h') }).toEqual({ opts, halves });
    }
  });

  it('reactions: 32 filter combinations, one LIMITed seek per network', () => {
    let checked = 0;
    for (const opts of grid({
      before: 100,
      networkId: netId,
      nicks: ['alice', 'bob'],
      target: '#grid',
      query: 'x',
    })) {
      const built = listReactionsToUserSql(userId, opts);
      expect({ opts, built: built !== null }).toEqual({ opts, built: true });
      checked += 1;
      const lines = pagePlan(built!.sql, built!.params);
      const halves = opts.networkId ? 1 : 2;
      expect({ opts, bad: offending(lines) }).toEqual({ opts, bad: [] });
      expect({
        opts,
        seeks: count(
          lines.join(' | '),
          seek(
            'idx_message_reactions_to_self_standing',
            'network_id=\\?',
            opts.before ? 'id<\\?' : null,
          ),
        ),
      }).toEqual({ opts, seeks: halves });
      expect({ opts, halves: halfLimits(built!.sql, 'r') }).toEqual({ opts, halves });
    }
    expect(checked).toBe(32);
  });

  it('bookmarks: both pages walk the bookmark index backwards', () => {
    for (const opts of [{}, { before: 100 }]) {
      const built = listBookmarksForUserSql(userId, opts);
      const lines = pagePlan(built.sql, built.params);
      expect({ opts, bad: offending(lines) }).toEqual({ opts, bad: [] });
      expect({
        opts,
        seeks: count(
          lines.join(' | '),
          seek(
            'COVERING INDEX idx_user_bookmarks_user_msg',
            'user_id=\\?',
            'before' in opts ? 'message_id<\\?' : null,
          ),
        ),
      }).toEqual({ opts, seeks: 1 });
    }
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

// The highlight partial indexes carry their payload columns so the highlight
// reads and counts are index-only (#1073). A deployed DB keeps the older
// payload-less shape under the same name unless the boot heal compares the
// DDL — exercised here against deliberately old indexes, as a fresh DB never
// takes that path — and a heal of the current shape must not rebuild.
describe('highlight index heal', () => {
  // Any DDL bumps the schema version; a freed root page can be reused by the
  // CREATE, so the page number alone can't tell a no-op from a rebuild.
  const schemaVersion = () => db.pragma('schema_version', { simple: true }) as number;

  it('rebuilds payload-less highlight indexes to the covering shape, once', async () => {
    const { ensureHighlightIndexesCurrent } = await import('./index.js');
    for (const [name, stamp] of [
      ['idx_messages_matched_buf', 'matched_rule_id IS NOT NULL'],
      ['idx_messages_reply_self_buf', 'reply_to_self = 1'],
    ] as const) {
      db.exec(`DROP INDEX ${name}`);
      db.exec(`CREATE INDEX ${name} ON messages(buffer_id, id DESC) WHERE ${stamp}`);
    }
    const probe = (name: string, stamp: string) =>
      plan(`SELECT COUNT(*) FROM messages INDEXED BY ${name}
        WHERE buffer_id = 1 AND id > 0 AND ${stamp} AND from_ignored = 0 AND notable = 1`);
    expect(probe('idx_messages_matched_buf', 'matched_rule_id IS NOT NULL')).not.toMatch(
      /COVERING/,
    );
    expect(probe('idx_messages_reply_self_buf', 'reply_to_self = 1')).not.toMatch(/COVERING/);
    ensureHighlightIndexesCurrent();
    expect(probe('idx_messages_matched_buf', 'matched_rule_id IS NOT NULL')).toMatch(
      /USING COVERING INDEX idx_messages_matched_buf/,
    );
    expect(probe('idx_messages_reply_self_buf', 'reply_to_self = 1')).toMatch(
      /USING COVERING INDEX idx_messages_reply_self_buf/,
    );
    const before = schemaVersion();
    ensureHighlightIndexesCurrent();
    expect(schemaVersion()).toBe(before);
  });
});

// The bouncer's CHATHISTORY windows (loadHistoryWindow) order by TIME — a
// timestamp API — and before idx_messages_buf_time every window walked the
// buffer's whole history through the id index and sorted it (#1075). Every
// window shape, with and without event playback, must be one range seek on
// the time index, cursor bounds inside the seek, no sort.
describe('chathistory window grid', () => {
  it('32 window shapes, each one seek on idx_messages_buf_time', async () => {
    const { loadHistoryWindowSql } = await import('./messages.js');
    const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
    let checked = 0;
    for (const lower of [null, t(1)]) {
      for (const upper of [null, t(9)]) {
        for (const newestFirst of [false, true]) {
          for (const events of [null, { me: 'alice' }]) {
            for (const withoutSelf of [false, true]) {
              const shape = { lower, upper, newestFirst, events, withoutSelf };
              const built = loadHistoryWindowSql(1, 'rfc1459', lower, upper, 50, {
                newestFirst,
                events,
                withoutSelf,
              });
              const lines = (
                db.prepare(`EXPLAIN QUERY PLAN ${built.sql}`).all(...built.params) as Array<{
                  detail: string;
                }>
              ).map((r) => r.detail);
              const range = `buffer_id=\\?${lower ? ' AND time>\\?' : ''}${upper ? ' AND time<\\?' : ''}`;
              expect({
                shape,
                seek: lines.filter((d) =>
                  new RegExp(
                    `SEARCH messages USING INDEX idx_messages_buf_time \\(${range}\\)`,
                  ).test(d),
                ).length,
                bad: lines.filter((d) => /TEMP B-TREE|^SCAN messages/.test(d)),
              }).toEqual({ shape, seek: 1, bad: [] });
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(32);
  });

  // CHATHISTORY TARGETS (listActiveTargetsInWindow shape, messages arm): the
  // same index turns each buffer's contribution from a walk of its whole
  // history into a seek of the asked-for time range. The sort is over one row
  // per buffer, not per message.
  it('TARGETS seeks each buffer by the time range', async () => {
    await import('./messages.js'); // registers the SQL functions the statement names
    const detail = plan(
      `SELECT b.target AS target, MAX(m.time) AS lastMessageAt
         FROM messages m JOIN buffers b ON b.id = m.buffer_id
        WHERE b.network_id = 1
          AND b.kind NOT IN ('server', 'system', 'dcc') AND substr(b.target, 1, 1) <> '='
          AND NOT (b.kind = 'dm' AND (m.self = 1) AND (0 OR lurker_is_services_nick(b.target)))
          AND m.type IN ('message', 'action', 'notice') AND m.mirrored = 0
          AND m.text IS NOT NULL AND m.text != ''
          AND m.time > '2026-01-01' AND m.time < '2026-02-01'
        GROUP BY b.id ORDER BY lastMessageAt DESC LIMIT 50`,
    );
    expect(detail).toMatch(
      /SEARCH m USING INDEX idx_messages_buf_time \(buffer_id=\? AND time>\? AND time<\?\)/,
    );
  });
});

// MARKREAD maps a read pointer (an id) to a time and back (bouncer.ts). Both
// lookups run on a client's command and must stay seeks on the per-buffer id
// index. idx_messages_buf_time (buffer_id, time) now offers the planner a
// competing path for the time-bounded steps; these pins are what keep it
// from taking one and turning a MARKREAD into a walk and a sort.
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

describe('retention paths', () => {
  // The band window's delete (db/retention.ts), planned from the text it
  // prepares: the window rides the per-buffer index, and each thread probe
  // is a seek.
  it('the band delete rides the per-buffer index, its thread probes seeks', async () => {
    const { BAND_DELETE_SQL } = await import('./retention.js');
    const detail = (
      db.prepare(`EXPLAIN QUERY PLAN ${BAND_DELETE_SQL}`).all({
        bufferId: 1,
        walkFrom: 100,
        low: 10,
        ownerId: 1,
        boundaryId: 100,
      }) as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(detail).toMatch(/SEARCH m USING (COVERING )?INDEX idx_messages_buf_unread/);
    expect(detail).toMatch(/SEARCH r USING (COVERING )?INDEX idx_messages_reply_root/);
    expect(detail).toMatch(/SEARCH q USING INDEX idx_messages_msgid/);
    expect(detail).not.toMatch(/SCAN messages/);
  });
});
