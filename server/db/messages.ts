// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** A raw row from the `messages` table. */
interface MessageRow {
  id: number;
  network_id: number;
  target: string;
  time: string;
  type: string;
  nick: string | null;
  text: string | null;
  kind: string | null;
  self: number;
  extra: string | null;
  userhost: string | null;
  alt: number;
  matched_rule_id: number | null;
  from_ignored: number;
  mirrored: number;
  msgid: string | null;
}

/** A raw message row joined with network_name. */
interface MessageRowWithNetwork extends MessageRow {
  network_name: string;
}

/** A message event as returned to callers. */
export interface MessageEvent {
  id: number;
  networkId: number;
  target: string;
  time: string;
  type: string;
  nick: string | null;
  text: string | null;
  kind: string | null;
  self: boolean;
  userhost: string | null;
  alt: boolean;
  matched: boolean;
  matchedRuleId: number | null;
  fromIgnored: boolean;
  // A duplicate of a closed-buffer NOTICE surfaced in the server buffer (#439).
  // Excluded from search/highlights so it doesn't double up its real copy.
  mirrored: boolean;
  // IRCv3 server-assigned message id (#450). Only set when the network supplied
  // one — absent (not null) otherwise, so untagged backlogs don't grow a field.
  msgid?: string;
  [key: string]: unknown;
}

/** MessageEvent enriched with the network name. */
export interface MessageEventWithNetwork extends MessageEvent {
  networkName: string;
}

/** Input shape for insertMessage. */
export interface MessageInput {
  networkId: number;
  target: string;
  time: string;
  type: string;
  nick?: string | null;
  text?: string | null;
  kind?: string | null;
  self?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any> | null; // untyped IRC extra fields
  matchedRuleId?: number | null;
  userhost?: string | null;
  fromIgnored?: boolean;
  mirrored?: boolean;
  msgid?: string | null;
  // Server-buffer notability (#470). Defaults to notable (true); pass false for
  // Lurker's own connection-status notices so they render in the server buffer
  // but don't mark it unread. Read by countServerBufferUnread (the :server: unread
  // count) and countHighlightsNewer (which excludes notable=0 lines from highlights).
  notable?: boolean;
}

/** Buffer summary row for MCP list_buffers. */
export interface BufferSummary {
  target: string;
  lastMessageAt: string;
}

/** (target, maxId) pair for mark-all-read. */
export interface MaxIdByBufferRow {
  target: string;
  maxId: number;
}

// Alt parity is computed inline against the buffer's most recent striped row.
// Better-sqlite3 is synchronous and the IRC pipeline is single-threaded, so
// the subselect-then-insert can't observe a torn write — no transaction needed.
// Non-striped types pass through with alt=0; the value is meaningless for them
// and the client never reads it.
const insertStmt = db.prepare(`
  INSERT INTO messages (network_id, target, time, type, nick, text, kind, self, extra, matched_rule_id, userhost, from_ignored, mirrored, notable, msgid, alt)
  VALUES (
    @networkId, @target, @time, @type, @nick, @text, @kind, @self, @extra, @matchedRuleId, @userhost, @fromIgnored, @mirrored, @notable, @msgid,
    CASE WHEN @type IN ('message', 'action', 'notice')
         THEN 1 - COALESCE(
           (SELECT alt FROM messages
             WHERE network_id = @networkId AND target = @target
               AND type IN ('message', 'action', 'notice')
             ORDER BY id DESC LIMIT 1),
           1)
         ELSE 0
    END
  )
`);

const altByIdStmt = db.prepare(`SELECT alt FROM messages WHERE id = ?`);

export function insertMessage(row: MessageInput): { id: number | bigint; alt: boolean } {
  const result = insertStmt.run({
    networkId: row.networkId,
    target: row.target,
    time: row.time,
    type: row.type,
    nick: row.nick ?? null,
    text: row.text ?? null,
    kind: row.kind ?? null,
    self: row.self ? 1 : 0,
    extra: row.extra ? JSON.stringify(row.extra) : null,
    matchedRuleId: row.matchedRuleId ?? null,
    userhost: row.userhost ?? null,
    fromIgnored: row.fromIgnored ? 1 : 0,
    mirrored: row.mirrored ? 1 : 0,
    // Default notable=1; only an explicit `false` (Lurker's status notices) is 0.
    notable: row.notable === false ? 0 : 1,
    msgid: row.msgid ?? null,
  });
  const id = result.lastInsertRowid;
  const altRow = altByIdStmt.get(id) as { alt: number } | undefined;
  return { id, alt: altRow?.alt === 1 };
}

function rowToEvent(row: MessageRow): MessageEvent {
  const event: MessageEvent = {
    id: row.id,
    networkId: row.network_id,
    target: row.target,
    time: row.time,
    type: row.type,
    nick: row.nick,
    text: row.text,
    kind: row.kind,
    self: !!row.self,
    userhost: row.userhost ?? null,
    alt: row.alt === 1,
    matched: row.matched_rule_id != null,
    matchedRuleId: row.matched_rule_id,
    fromIgnored: row.from_ignored === 1,
    mirrored: row.mirrored === 1,
  };
  if (row.msgid) event.msgid = row.msgid;
  if (row.extra) {
    try {
      Object.assign(event, JSON.parse(row.extra));
    } catch (_) {
      /* ignore malformed */
    }
  }
  return event;
}

// `before` paginates backward (returns up to `limit` events with id < before).
// `afterId` does the opposite — used by the WS resume path to ship only the
// gap an existing client missed, instead of re-sending its last 50 known rows.
// Results are always returned oldest-first regardless of which path was taken.
export function listMessages(
  networkId: number,
  target: string,
  { before, afterId, limit = 50 }: { before?: number; afterId?: number; limit?: number } = {},
): MessageEvent[] {
  if (afterId) {
    const rows = db
      .prepare(
        `SELECT * FROM messages WHERE network_id = ? AND target = ? AND id > ?
       ORDER BY id ASC LIMIT ?`,
      )
      .all(networkId, target, afterId, limit) as MessageRow[];
    return rows.map(rowToEvent);
  }
  const sql = before
    ? `SELECT * FROM messages WHERE network_id = ? AND target = ? AND id < ? ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM messages WHERE network_id = ? AND target = ? ORDER BY id DESC LIMIT ?`;
  const params = before ? [networkId, target, before, limit] : [networkId, target, limit];
  const rows = db.prepare(sql).all(...params) as MessageRow[];
  return rows.map(rowToEvent).toReversed();
}

// Bounded context window around an arbitrary message id. Used by the
// jump-to-message UX (search results, highlights) — loads halfLimit older rows
// + the anchor + halfLimit newer rows. The anchor lookup also enforces
// (networkId, target) so callers can't lift rows out of buffers they don't own
// just by knowing a message id. Returns oldest-first.
export function listMessagesAround(
  networkId: number,
  target: string,
  anchorId: number,
  halfLimit = 100,
):
  | { events: MessageEvent[]; hasMoreOlder: boolean; hasMoreNewer: boolean }
  | { events: []; hasMoreOlder: false; hasMoreNewer: false; anchorMissing: true } {
  const anchorRow = db
    .prepare(`SELECT * FROM messages WHERE id = ? AND network_id = ? AND target = ?`)
    .get(anchorId, networkId, target) as MessageRow | undefined;
  if (!anchorRow) {
    return { events: [], hasMoreOlder: false, hasMoreNewer: false, anchorMissing: true };
  }
  const older = listMessages(networkId, target, { before: anchorId, limit: halfLimit });
  const newer = listMessages(networkId, target, { afterId: anchorId, limit: halfLimit });
  const events = [...older, rowToEvent(anchorRow), ...newer];
  const oldestId = events[0].id as number;
  const newestId = events[events.length - 1].id as number;
  return {
    events,
    hasMoreOlder: hasOlderThan(networkId, target, oldestId),
    hasMoreNewer: hasNewerThan(networkId, target, newestId),
  };
}

// Cheap edge-exists probes for the around/before/after handlers. Using a
// LIMIT 1 EXISTS-shaped query (rather than COUNT(*)) keeps this O(index seek)
// regardless of how much history is in the buffer.
function hasOlderThan(networkId: number, target: string, id: number): boolean {
  return !!db
    .prepare(`SELECT 1 FROM messages WHERE network_id = ? AND target = ? AND id < ? LIMIT 1`)
    .get(networkId, target, id);
}

function hasNewerThan(networkId: number, target: string, id: number): boolean {
  return !!db
    .prepare(`SELECT 1 FROM messages WHERE network_id = ? AND target = ? AND id > ? LIMIT 1`)
    .get(networkId, target, id);
}

// Public wrappers so wsHub can compute hasMoreOlder/Newer for the 'before',
// 'after', and 'latest' modes without re-declaring the SQL there.
export function hasOlderRow(networkId: number, target: string, id: number): boolean {
  return hasOlderThan(networkId, target, id);
}
export function hasNewerRow(networkId: number, target: string, id: number): boolean {
  return hasNewerThan(networkId, target, id);
}

// --- IRCv3 draft/chathistory window queries --------------------------------

// Only replayable conversation rows count toward a chathistory window/limit:
// joins/parts/quits/nick/mode/topic events and mirrored server-buffer dupes are
// excluded, so a `limit` of N yields up to N real messages (a window full of a
// netsplit's QUITs must not come back as an empty batch — that would make a
// client think it reached the start of history and stop paging). Matches what
// playbackLines will actually emit onto the wire.
const CHATHISTORY_MSG_FILTER = `type IN ('message', 'action', 'notice') AND mirrored = 0 AND text IS NOT NULL AND text != ''`;

// Windowed history fetch for CHATHISTORY. `lower`/`upper` are exclusive ISO time
// bounds (null = unbounded on that side). `newestFirst` takes the `limit` from
// the recent end of the window (BEFORE/LATEST) vs the old end (AFTER); the
// result is ALWAYS returned oldest-first (the batch must be chronological).
//
// Ordered by `time` (id as a stable tie-breaker for same-millisecond rows), NOT
// by id: chathistory is a timestamp-semantic API and a client pages by the
// returned lines' @time, so window selection and ordering must follow time.
// These usually coincide (id is assigned in receive order), but a chained/ZNC
// upstream that replays its buffer as live PRIVMSGs with old server-time tags
// (stored as event.time) breaks that — old-time rows get fresh, high ids. The
// time sort is unindexed, but this is an on-demand path with a bounded LIMIT.
export function loadHistoryWindow(
  networkId: number,
  target: string,
  lower: string | null,
  upper: string | null,
  limit: number,
  { newestFirst = false }: { newestFirst?: boolean } = {},
): MessageEvent[] {
  const conds = ['network_id = ?', 'target = ?', CHATHISTORY_MSG_FILTER];
  const params: (string | number)[] = [networkId, target];
  if (lower !== null) {
    conds.push('time > ?');
    params.push(lower);
  }
  if (upper !== null) {
    conds.push('time < ?');
    params.push(upper);
  }
  params.push(limit);
  const dir = newestFirst ? 'DESC' : 'ASC';
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE ${conds.join(' AND ')}
       ORDER BY time ${dir}, id ${dir} LIMIT ?`,
    )
    .all(...params) as MessageRow[];
  const events = rows.map(rowToEvent);
  return newestFirst ? events.toReversed() : events;
}

// Buffers with real message activity inside a time window (exclusive), newest
// first, for CHATHISTORY TARGETS. Excludes :server: pseudo-buffers and applies
// the same message filter (a buffer whose only in-window rows are JOINs isn't
// "active"). The two bounds may arrive in either order; we normalize.
export function listActiveTargetsInWindow(
  networkId: number,
  isoA: string,
  isoB: string,
  limit: number,
): BufferSummary[] {
  const [lo, hi] = isoA <= isoB ? [isoA, isoB] : [isoB, isoA];
  return db
    .prepare(
      `SELECT target, MAX(time) AS lastMessageAt
         FROM messages
        WHERE network_id = ?
          AND target NOT LIKE ':server:%'
          AND ${CHATHISTORY_MSG_FILTER}
          AND time > ? AND time < ?
        GROUP BY target
        ORDER BY lastMessageAt DESC
        LIMIT ?`,
    )
    .all(networkId, lo, hi, limit) as BufferSummary[];
}

export function listRecentForBuffers(
  networkId: number,
  targets: string[],
  perBuffer = 50,
): Record<string, MessageEvent[]> {
  const out: Record<string, MessageEvent[]> = {};
  for (const t of targets) {
    out[t] = listMessages(networkId, t, { limit: perBuffer });
  }
  return out;
}

// Distinct buffer targets (channels/DMs/:server:) that have history on a network
// — the sidebar's buffer list. Called several times per connect snapshot (per
// network, in the online loop / offline frames / app-badge total), so it's on
// the hot path — hence the module-scoped prepared statement.
//
// A plain `SELECT DISTINCT target` visits EVERY message row: SQLite reads the
// whole (network_id, target, id) index and de-dupes in the output rather than
// seeking past duplicate targets, so it scaled with the network's ENTIRE history
// and was the dominant snapshot cost on a deep buffer. This is a recursive "loose
// index scan" (skip-scan): it seeks to the smallest target, then repeatedly to
// the next target strictly greater, so it's O(distinct targets) index seeks — a
// ~75x speedup measured on 50k rows / 8 targets, and far more on real history.
//
// The `IS NOT NULL` guards are LOAD-BEARING, not defensive: `min(target)` returns
// NULL for a network with no messages, and the recursive subquery returns NULL
// once no larger target exists — that NULL sentinel is what terminates the
// recursion (via `WHERE t.target IS NOT NULL`) and is filtered from the output.
const listBufferTargetsStmt = db.prepare(`
  WITH RECURSIVE t(target) AS (
    SELECT min(target) FROM messages WHERE network_id = ?
    UNION ALL
    SELECT (SELECT min(target) FROM messages WHERE network_id = ? AND target > t.target)
    FROM t
    WHERE t.target IS NOT NULL
  )
  SELECT target FROM t WHERE target IS NOT NULL ORDER BY target
`);
export function listBufferTargets(networkId: number): string[] {
  return (listBufferTargetsStmt.all(networkId, networkId) as Array<{ target: string }>).map(
    (r) => r.target,
  );
}

// Per-(network, target) summary for the MCP list_buffers verb. Aggregates
// every target that has at least one message, with the freshest message
// timestamp. Pseudo-buffers (':server:*') are filtered at the SQL layer so
// they never leak into the agent-facing surface; clients reach them via the
// snapshot only.
export function listBuffersForNetwork(networkId: number): BufferSummary[] {
  return db
    .prepare(
      `SELECT target, MAX(time) AS lastMessageAt
         FROM messages
        WHERE network_id = ?
          AND target NOT LIKE ':server:%'
        GROUP BY target
        ORDER BY lastMessageAt DESC`,
    )
    .all(networkId) as BufferSummary[];
}

// (target, max_id) per buffer in this network. Used by /mark-all-read so the
// server can clamp every buffer's read pointer to its tail in one pass.
export function maxIdByBuffer(networkId: number): MaxIdByBufferRow[] {
  return db
    .prepare('SELECT target, MAX(id) AS maxId FROM messages WHERE network_id = ? GROUP BY target')
    .all(networkId) as MaxIdByBufferRow[];
}

// MAX(id) across the whole messages table, or 0 when empty. message ids are a
// single global monotonic sequence, so this is a safe "caught up to now" cursor
// value: a fresh (shell) connect ships no message rows, so we hand the client
// this so its next reconnect's ?since only pulls genuinely-new events rather
// than re-gap-filling everything. Not user-scoped by design — it's only a
// threshold number (>= any of the caller's own ids), never row data.
export function maxMessageId(): number {
  const row = db.prepare('SELECT MAX(id) AS maxId FROM messages').get() as
    | { maxId: number | null }
    | undefined;
  return row?.maxId || 0;
}

// MAX(id) for a single buffer, or 0 when the buffer has no rows. Used by
// /clear to anchor the marker at the current tail.
export function maxIdForBuffer(networkId: number, target: string): number {
  const row = db
    .prepare('SELECT MAX(id) AS maxId FROM messages WHERE network_id = ? AND target = ?')
    .get(networkId, target) as { maxId: number | null } | undefined;
  return row?.maxId || 0;
}

// Cheap "does the user have any history with this target?" check used by the
// no_such_nick router: only route a DM-shaped error into a per-nick buffer if
// the user has actually conversed with that nick. Stops typo /whois replies
// from spawning empty DM buffers.
export function hasMessageForTarget(networkId: number, target: string): boolean {
  if (!networkId || !target) return false;
  const row = db
    .prepare('SELECT 1 FROM messages WHERE network_id = ? AND target = ? COLLATE NOCASE LIMIT 1')
    .get(networkId, target);
  return !!row;
}

// Whether a target has a real (non-notice) conversation — at least one PRIVMSG or
// ACTION. NOTICE-only buffers (services like NickServ/ChanServ, which now get a
// buffer of their own, #439) are NOT conversations: presence-tracking keys off
// this so services don't consume MONITOR slots or show a presence dot.
export function hasConversationForTarget(networkId: number, target: string): boolean {
  if (!networkId || !target) return false;
  const row = db
    .prepare(
      "SELECT 1 FROM messages WHERE network_id = ? AND target = ? COLLATE NOCASE AND type IN ('message', 'action') LIMIT 1",
    )
    .get(networkId, target);
  return !!row;
}

export function countOlder(networkId: number, target: string, beforeId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE network_id = ? AND target = ? AND id < ?`)
      .get(networkId, target, beforeId) as { n: number }
  ).n;
}

// Types that count as "real content" for the unread badge in a channel or DM.
// Membership churn (join/part/quit/kick/nick/mode/topic), MOTD, and away markers
// are persisted for the buffer log but don't bump the badge. `error` is excluded
// HERE but the `:server:` buffer does count it (see SERVER_COUNTABLE_TYPES /
// typeCountsForUnread below) — a killed/banned/disconnect line should badge the
// server tab. The client no longer mirrors any allowlist: unread is driven purely
// by the server's read-state broadcast (whose trigger uses typeCountsForUnread),
// so this set only has to stay in sync with the count queries in this file.
export const COUNTABLE_TYPES = new Set(['message', 'action', 'notice']);
const COUNTABLE_TYPES_SQL = `('${[...COUNTABLE_TYPES].join("','")}')`;

// Unread badges cap their display at ">999" (client BufferList.unreadLabel), so
// the exact count past that is never shown — yet an unbounded COUNT scans the
// buffer's ENTIRE unread range (every row with id > the read pointer), which is
// the dominant per-buffer cost of a connect snapshot on a deep buffer with a low
// read pointer. Cap the count at UNREAD_COUNT_CAP: the inner ORDER BY id DESC +
// LIMIT lets SQLite walk idx_messages_buffer(network_id, target, id DESC) and
// stop once that many countable rows are found. Any value >= the cap renders
// identically (">999"); below the cap it's still exact.
//
// NOTE: computeUnreadFor treats a DM's unread AS its highlight count (DMs are
// inherently mentions), so a DM with >cap unread has its highlight count — and
// thus its contribution to the PWA app-icon badge total — capped here too. That
// is intended and invisible: both the sidebar badge and the OS app badge collapse
// past ~999 anyway, and keeping DM highlights exact would mean reintroducing the
// unbounded scan for DMs. Channel highlights are exact (their own indexed count).
export const UNREAD_COUNT_CAP = 1000;

// The server pseudo-buffer also counts `error` lines (killed/banned/connection
// failures, and the QUIT-echo disconnect line — all SHOULD badge it), which
// countNewer's type set omits. Derived from COUNTABLE_TYPES so the paths can't
// drift.
const SERVER_COUNTABLE_TYPES = new Set([...COUNTABLE_TYPES, 'error']);
const SERVER_COUNTABLE_TYPES_SQL = `('${[...SERVER_COUNTABLE_TYPES].join("','")}')`;

// Does an event of `type` count toward `target`'s unread badge? This is the same
// rule countNewer / countServerBufferUnread apply, exposed so the live read-state
// broadcast trigger (wsHub) can tell whether an event changed the count without
// re-implementing it. Crucially a `:server:` 'error' counts here — otherwise its
// badge wouldn't refresh until the next ordinary countable event landed (a
// reconnect's "Connecting…" notice), which is the delayed-badge bug (#470).
export function typeCountsForUnread(target: string, type: string): boolean {
  return target.startsWith(':server:')
    ? SERVER_COUNTABLE_TYPES.has(type)
    : COUNTABLE_TYPES.has(type);
}

// Shared unread-count core for countNewer and countServerBufferUnread. Both need
// the same cap guard and the same ORDER BY id DESC LIMIT index walk; they differ
// only in the countable type set and whether the notability filter applies. Kept
// as one body so the LIMIT-guard invariant (a bad cap must not become SQLite's
// unbounded `LIMIT -1`) lives in exactly one place.
function countUnreadRows(
  networkId: number,
  target: string,
  afterId: number,
  typesSql: string,
  notableOnly: boolean,
  cap: number,
): number {
  const lim = Number.isInteger(cap) && cap > 0 ? cap : UNREAD_COUNT_CAP;
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM messages
           WHERE network_id = ? AND target = ? AND id > ?
             AND type IN ${typesSql}
             ${notableOnly ? 'AND notable = 1' : ''}
             AND from_ignored = 0
           ORDER BY id DESC
           LIMIT ?
         )`,
      )
      .get(networkId, target, afterId || 0, lim) as { n: number }
  ).n;
}

export function countNewer(
  networkId: number,
  target: string,
  afterId: number,
  cap = UNREAD_COUNT_CAP,
): number {
  return countUnreadRows(networkId, target, afterId, COUNTABLE_TYPES_SQL, false, cap);
}

// Unread count for a `:server:` pseudo-buffer (#470). Differs from countNewer in
// two ways: it also counts `error` rows (a killed/banned/connection-failed line
// SHOULD mark the server buffer unread — those are type 'error', which countNewer
// excludes), and it counts only `notable = 1` rows so Lurker's own routine
// connection-status notices (connecting/reconnecting/nick-status/monitor-limit,
// stamped notable=0 at publish) don't. Genuine inbound notices/messages and
// closed-buffer NOTICE mirrors are notable by default, so they still badge.
export function countServerBufferUnread(
  networkId: number,
  target: string,
  afterId: number,
  cap = UNREAD_COUNT_CAP,
): number {
  return countUnreadRows(networkId, target, afterId, SERVER_COUNTABLE_TYPES_SQL, true, cap);
}

// Cheap indexed count of unread highlights since `afterId`. Uses the partial
// idx_messages_matched index — the old scan+decorate approach was replaced
// once match state moved to insert time. Ignored senders are excluded so the
// red highlight pip doesn't fire for someone the user can't see. notable=0 lines
// are excluded too (#470): a Lurker status notice that happens to match a self-
// nick rule ("Reclaimed nick <you>.") must not highlight the server buffer when
// it's deliberately not even counted as unread.
export function countHighlightsNewer(networkId: number, target: string, afterId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
     WHERE network_id = ? AND target = ? AND id > ?
       AND matched_rule_id IS NOT NULL
       AND from_ignored = 0
       AND notable = 1`,
      )
      .get(networkId, target, afterId || 0) as { n: number }
  ).n;
}

// Highlight history feed for the /api/highlights endpoint. Scoped to a single
// user via the networks join. Cursor pagination via `before` (a message id);
// returns rows ordered newest-first.
export function listUserHighlights(
  userId: number,
  { before, limit = 50 }: { before?: number; limit?: number } = {},
): MessageEventWithNetwork[] {
  const sql = before
    ? `SELECT m.*, n.name AS network_name
       FROM messages m
       JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = ?
         AND m.matched_rule_id IS NOT NULL
         AND m.from_ignored = 0
         AND m.id < ?
       ORDER BY m.id DESC
       LIMIT ?`
    : `SELECT m.*, n.name AS network_name
       FROM messages m
       JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = ?
         AND m.matched_rule_id IS NOT NULL
         AND m.from_ignored = 0
       ORDER BY m.id DESC
       LIMIT ?`;
  const params = before ? [userId, before, limit] : [userId, limit];
  const rows = db.prepare(sql).all(...params) as MessageRowWithNetwork[];
  return rows.map((row) => ({
    ...rowToEvent(row),
    networkName: row.network_name,
  }));
}

// Turn a free-text query into an FTS5 MATCH string. Each whitespace-separated
// term is wrapped in double quotes (embedded quotes doubled to escape them),
// which neutralizes FTS5 operator characters in user input and ANDs the terms
// together implicitly.
function toFtsMatch(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

// Full-text search across the caller's message history. Free-text `query` runs
// against the messages_fts index; `networkId` / `target` / `nick` are
// structured filters (the inline from:/in:/on: search syntax). The networks
// join scopes every result to the caller's own networks — this is the
// access-control boundary, so a missing networkId means "all my networks", not
// "all networks". Cursor pagination via `before` (a message id); rows ordered
// newest-first, restricted to chat-shaped types. Ignored senders are excluded
// via the insert-time from_ignored stamp (same as listUserHighlights / the
// unread counts) so an ignored user stays ignored everywhere, including for
// non-UI consumers of the search verb that have no client-side ignore filter.
//
// `matched: true` restricts to highlight rows (matched_rule_id IS NOT NULL) —
// this is what powers filterable highlights, which reuse the same from:/in:/on:
// + free-text machinery as search. Unlike plain search, an all-empty filter set
// is valid when `matched` is set: it means "all my highlights".
export function searchMessages(
  userId: number,
  {
    query,
    networkId,
    target,
    nick,
    nicks,
    matched,
    before,
    limit = 50,
  }: {
    query?: string;
    networkId?: number;
    target?: string;
    nick?: string;
    nicks?: string[];
    matched?: boolean;
    before?: number;
    limit?: number;
  } = {},
): MessageEventWithNetwork[] {
  const text = typeof query === 'string' ? query.trim() : '';
  const nickList = (nicks ?? []).filter((n) => typeof n === 'string' && n);
  // Nothing to search on — no free text and no structured filter. With
  // `matched` the empty case is meaningful ("all my highlights"), so skip the
  // early-out for it.
  if (!text && !networkId && !target && !nick && nickList.length === 0 && !matched) return [];

  let from = 'messages m JOIN networks n ON n.id = m.network_id';
  const where: string[] = [
    'n.user_id = ?',
    `m.type IN ${COUNTABLE_TYPES_SQL}`,
    'm.from_ignored = 0',
    // Skip server-buffer mirror duplicates of closed-buffer NOTICEs (#439) so a
    // mirrored notice doesn't surface twice — its real copy in the sender's
    // buffer is the searchable one. Genuine server-buffer notices (mirrored = 0)
    // stay searchable.
    'm.mirrored = 0',
  ];
  const params: (string | number)[] = [userId];

  // Placed before the FTS join so the partial idx_messages_matched index
  // (WHERE matched_rule_id IS NOT NULL) is available to the planner.
  if (matched) {
    where.push('m.matched_rule_id IS NOT NULL');
  }

  if (text) {
    const match = toFtsMatch(text);
    if (!match) return [];
    // FTS5's MATCH operator must reference the virtual table by its real name,
    // not an alias — `alias MATCH ?` parses `alias` as a column.
    from += ' JOIN messages_fts ON messages_fts.rowid = m.id';
    where.push('messages_fts MATCH ?');
    params.push(match);
  }
  if (networkId) {
    where.push('m.network_id = ?');
    params.push(networkId);
  }
  if (target) {
    where.push('m.target = ? COLLATE NOCASE');
    params.push(target);
  }
  // `nicks` OR-matches several senders (a friend's alts); `nick` is the single
  // case. COLLATE NOCASE binds to the column so the IN comparison is case-fold.
  if (nickList.length > 0) {
    where.push(`m.nick COLLATE NOCASE IN (${nickList.map(() => '?').join(', ')})`);
    params.push(...nickList);
  } else if (nick) {
    where.push('m.nick = ? COLLATE NOCASE');
    params.push(nick);
  }
  if (before) {
    where.push('m.id < ?');
    params.push(before);
  }

  const sql = `SELECT m.*, n.name AS network_name
               FROM ${from}
               WHERE ${where.join(' AND ')}
               ORDER BY m.id DESC
               LIMIT ?`;
  params.push(limit);

  return (db.prepare(sql).all(...params) as MessageRowWithNetwork[]).map((row) => ({
    ...rowToEvent(row),
    networkName: row.network_name,
  }));
}

// Autocomplete speakers, derived from message history. This is now called when
// the user OPENS a buffer (the 'history' latest reply seeds nick completion) — the
// connect snapshot no longer ships speakers — so it's one buffer at a time, not
// every buffer at once. Still, bound the work to the most recent
// SPEAKER_SCAN_WINDOW *chat* rows, THEN group, so it's O(window) regardless of how
// deep the buffer is. The window is small: autocomplete only cares about the last
// handful of speakers, and the client keeps building the list live via
// recordSpeaker as the conversation continues. The filters live INSIDE the
// windowed subquery on purpose: SQLite walks the tail of idx_messages_buffer(
// network_id, target, id DESC) applying them, so a burst of non-chat rows (a
// netsplit's join/quit flood) is skipped rather than eating the window and
// starving the speaker set. (Backfilled CHATHISTORY isn't a concern: those batches
// are dropped, not inserted, so id order tracks time order — see ircConnection.ts.)
const SPEAKER_SCAN_WINDOW = 300;
const listSpeakersStmt = db.prepare(`
  -- Exactly one MAX() aggregate, so SQLite takes the bare (non-grouped) \`nick\`
  -- from the same row that supplied MAX(time) — i.e. the most-recent casing,
  -- consistent with last_time. (SQLite's documented min/max bare-column rule.)
  SELECT nick, MAX(time) AS last_time
  FROM (
    SELECT nick, time
    FROM messages
    WHERE network_id = ? AND target = ?
      AND type IN ('message', 'action')
      AND self = 0
      AND nick IS NOT NULL
      AND nick <> ''
    ORDER BY id DESC
    LIMIT ?
  )
  GROUP BY LOWER(nick)
  ORDER BY last_time DESC
  LIMIT ?
`);

export function listSpeakers(
  networkId: number,
  target: string,
  // Recent distinct speakers for nick autocomplete. Currently-present users
  // already come from the channel member list (NAMES); this only adds people who
  // spoke recently and have since left, so a small count is plenty.
  limit = 20,
  scanWindow = SPEAKER_SCAN_WINDOW,
): Array<{ nick: string; lastTime: number }> {
  return (
    listSpeakersStmt.all(networkId, target, scanWindow, limit) as Array<{
      nick: string;
      last_time: string;
    }>
  )
    .map((r) => ({ nick: r.nick, lastTime: Date.parse(r.last_time) || 0 }))
    .filter((s) => s.lastTime > 0);
}
