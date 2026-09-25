// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import {
  resolveBuffer,
  resolveBufferIdByNetwork,
  resolveOrMintForInsert,
} from './bufferResolve.js';
import { markBufferDirty, noteNoiseInsert } from './retention.js';
import { networkCasemapping } from './buffers.js';
import { foldTargetWith } from './casemapping.js';
import type { Casemapping } from './casemapping.js';
import { EARLY_PRUNE_TYPES } from '../../shared/eventFilter.js';
import { countsTowardPage } from '../../shared/eventFilter.js';
import type { PageUnit } from '../../shared/eventFilter.js';
import type { ModeChange } from '../../shared/modes.js';
import type { MessageReaction } from '../../shared/reactions.js';

// Buffer identity is buffers.id as of schema 17: every predicate in this file
// filters on `buffer_id`, and `target` is written at insert as an observation
// (the name the network used at that moment) but never read as a key. The
// exported signatures still take (networkId, target) — callers hold names —
// so each entry point resolves name → id exactly once, up front, through
// bufferResolve. A resolution miss means "no such buffer": empty results,
// false, zero — the same shape an unknown name produced before.

/** A raw row from the `messages` table. */
interface MessageRow {
  id: number;
  network_id: number;
  buffer_id: number;
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
  // 0/1 from the computed `bookmarked` column — see BOOKMARKED_COL. Optional
  // because it exists only on the SELECTs that ask for it.
  bookmarked?: number;
  // JSON array from the computed `reactions` column, NULL when there are none —
  // see REACTIONS_COL. Optional for the same reason as `bookmarked`.
  reactions?: string | null;
}

/** A raw message row joined with network_name. */
interface MessageRowWithNetwork extends MessageRow {
  network_name: string;
}

/** A message event as returned to callers. */
export interface MessageEvent {
  id: number;
  networkId: number;
  // buffers(id) the row belongs to — always present on rows read from the
  // table; optional because a handful of synthetic events (wsHub's
  // not-connected warnings) are decorated without ever being persisted.
  bufferId?: number;
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
  // Whether the owning user has saved this line. Absent (not `false`) when they
  // haven't, on the same reasoning as `msgid`: almost no row is bookmarked, and
  // a false on every row is pure wire weight. See BOOKMARKED_COL.
  bookmarked?: true;
  // IRCv3 reactions standing on this line, oldest first. Absent when there are
  // none, like `bookmarked`. See REACTIONS_COL.
  reactions?: MessageReaction[];
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
  INSERT INTO messages (network_id, buffer_id, target, time, type, nick, text, kind, self, extra, matched_rule_id, userhost, from_ignored, mirrored, notable, msgid, alt)
  VALUES (
    @networkId, @bufferId, @target, @time, @type, @nick, @text, @kind, @self, @extra, @matchedRuleId, @userhost, @fromIgnored, @mirrored, @notable, @msgid,
    CASE WHEN @type IN ('message', 'action', 'notice')
         THEN 1 - COALESCE(
           (SELECT alt FROM messages
             WHERE buffer_id = @bufferId
               AND type IN ('message', 'action', 'notice')
             ORDER BY id DESC LIMIT 1),
           1)
         ELSE 0
    END
  )
`);

const altByIdStmt = db.prepare(`SELECT alt FROM messages WHERE id = ?`);

export function insertMessage(row: MessageInput): {
  id: number | bigint;
  alt: boolean;
  bufferId: number;
} {
  // Resolved (or defensively minted) BEFORE the insert: a row that went in
  // with buffer_id NULL would be invisible to every id-keyed read forever.
  const bufferId = resolveOrMintForInsert(row.networkId, row.target);
  if (bufferId === undefined) {
    // Only reachable for a networkId that doesn't exist — the network FK
    // would reject the insert anyway; fail with a clearer message.
    throw new Error(`insertMessage: cannot resolve a buffer for network ${row.networkId}`);
  }
  const result = insertStmt.run({
    networkId: row.networkId,
    bufferId,
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
    // `||` not `??`: an empty-string msgid would be stored and indexed
    // (msgid IS NOT NULL) yet never surfaced — rowToEvent reads truthily.
    msgid: row.msgid || null,
  });
  const id = result.lastInsertRowid;
  // Retention prunes lazily: the sweep only ever looks at buffers that grew.
  markBufferDirty(bufferId);
  // A noise row whose stored time lies in the past (server-time/replay) can
  // land below the owner's noise-clock cursor; this rewinds it so the row is
  // still swept. See noteNoiseInsert.
  if (EARLY_PRUNE_TYPES.has(row.type)) noteNoiseInsert(bufferId, row.time);
  const altRow = altByIdStmt.get(id) as { alt: number } | undefined;
  // bufferId returned so the live publish path can stamp it onto the enriched
  // event without a second resolve — the wire's `irc` frames carry it.
  return { id, alt: altRow?.alt === 1, bufferId };
}

// Whether the owning user has bookmarked a row, computed per row rather than
// shipped as a wholesale id list at connect.
//
// The client only ever needs this flag for lines it is actually rendering, and a
// bookmark set is the one thing in the connect burst that grows without bound
// over an account's life — every other snapshot there (drafts, contacts) is
// naturally bounded. So the state travels with the messages that carry it, and
// the client keeps a Set of what it has seen rather than of everything it owns.
//
// The owner is derived from the message's own network, which is why no query in
// this file has to thread a userId to ask the question. `messages.network_id` is
// NOT NULL and foreign-keyed, so the subquery always resolves to exactly one
// user — this is the same join `addBookmark` gates its insert on, so what a row
// reports here and what the server will let you save can't disagree.
//
// System-buffer lines don't come through here at all: they live in their own
// `system_messages` table, which is also why they can't be bookmarked and why
// their ids overlap this table's.
//
// `alias` is the table's name or alias in the enclosing query, since some
// callers select from a bare `messages` and others from `messages m`.
const BOOKMARKED_COL = (alias: string) => `EXISTS (
    SELECT 1 FROM user_bookmarks ub
    WHERE ub.message_id = ${alias}.id
      AND ub.user_id = (SELECT n_own.user_id FROM networks n_own WHERE n_own.id = ${alias}.network_id)
  ) AS bookmarked`;

// The reactions standing on a row, as a JSON array built in SQL — the same
// ride-along as BOOKMARKED_COL, so every query that yields rows for a client
// yields their reactions without a second round-trip or any per-caller
// plumbing. Left off the bouncer's CHATHISTORY/playback reads
// (loadHistoryWindow, listRecentMessages): nothing there turns reactions into
// IRC lines, so on that hot path the column would be pure cost. The correlated subquery is a seek on idx_message_reactions_key
// (message_id leads it); a line nobody reacted to costs one empty probe. NULL,
// not '[]', when there are none, so rowToEvent can leave the field absent.
const REACTIONS_COL = (alias: string) => `(
    SELECT json_group_array(
      json_object('nick', r.nick, 'value', r.value, 'self', r.self) ORDER BY r.id
    )
    FROM message_reactions r
    WHERE r.message_id = ${alias}.id
    HAVING count(*) > 0
  ) AS reactions`;

function parseReactionsCol(raw: string | null | undefined): MessageReaction[] | null {
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as { nick: string; value: string; self: number }[];
    return list.map((r) => ({ nick: r.nick, value: r.value, self: r.self === 1 }));
  } catch (_) {
    return null;
  }
}

function rowToEvent(row: MessageRow): MessageEvent {
  const event: MessageEvent = {
    id: row.id,
    networkId: row.network_id,
    bufferId: row.buffer_id,
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
  // After the `extra` spread, and it CLEARS rather than merely overwrites.
  //
  // `extra` is JSON built from what a network sent us; `bookmarked` is a fact
  // about the reader's own account, so a stray key in there must never light up
  // a line nobody saved. Assigning-when-true alone wouldn't do it: on the rows
  // that matter — the unbookmarked ones — there'd be no assignment to overwrite
  // the forged value with, and it would sail through. The delete is the part
  // that makes the column authoritative.
  delete event.bookmarked;
  if (row.bookmarked) event.bookmarked = true;
  // Same rule for reactions: only the column may set them.
  delete event.reactions;
  const reactions = parseReactionsCol(row.reactions);
  if (reactions) event.reactions = reactions;
  return event;
}

// `before` paginates backward (returns up to `limit` events with id < before).
// `afterId` does the opposite — used by the WS resume path to ship only the
// gap an existing client missed, instead of re-sending its last 50 known rows.
// Results are always returned oldest-first regardless of which path was taken.
export function listMessages(
  networkId: number,
  target: string,
  opts: { before?: number; afterId?: number; limit?: number } = {},
): MessageEvent[] {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return [];
  return listMessagesById(bufferId, opts);
}

function listMessagesById(
  bufferId: number,
  { before, afterId, limit = 50 }: { before?: number; afterId?: number; limit?: number } = {},
): MessageEvent[] {
  if (afterId) {
    const rows = db
      .prepare(
        `SELECT *, ${BOOKMARKED_COL('messages')}, ${REACTIONS_COL('messages')} FROM messages WHERE buffer_id = ? AND id > ?
       ORDER BY id ASC LIMIT ?`,
      )
      .all(bufferId, afterId, limit) as MessageRow[];
    return rows.map(rowToEvent);
  }
  const sql = before
    ? `SELECT *, ${BOOKMARKED_COL('messages')}, ${REACTIONS_COL('messages')} FROM messages WHERE buffer_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
    : `SELECT *, ${BOOKMARKED_COL('messages')}, ${REACTIONS_COL('messages')} FROM messages WHERE buffer_id = ? ORDER BY id DESC LIMIT ?`;
  const params = before ? [bufferId, before, limit] : [bufferId, limit];
  const rows = db.prepare(sql).all(...params) as MessageRow[];
  return rows.map(rowToEvent).toReversed();
}

// --- Renderable-counted paging -------------------------------------------

// The same page, sized in the unit the reader perceives.
//
// `listMessages` counts rows in the `messages` table. Clients render
// CONSOLIDATED rows: a run of join/part/quit/nick/chghost collapses to one
// summary line. So on a channel with heavy presence churn a 100-row page can
// render as three visible lines — the client sees a short page, asks for
// another, folds that one too, and the user watches the buffer assemble itself
// (WS_PROTOCOL_FIXES #10). Only the server can see the type mix in a slice
// before it ships it, so only the server can size the page correctly.
//
// "Renderable" is deliberately the COMPLEMENT of the set the clients fold on,
// imported from shared/consolidate.ts rather than restated here — a `kick`,
// `mode`, `topic`, `error` or `invite` each renders as its own standalone line
// (consolidation excludes them on purpose), so each is worth one slot. Counting
// only message/action/notice would still under-fill a buffer whose traffic is
// kicks and topic edits.
//
// The `chat` unit (#666) is the same idea one rung stricter: a client on the
// `none` event tier draws nothing at all for join/part/quit/nick/chghost OR
// mode, so those must not spend budget either, or the reader pages through
// screenfuls of rows that render as nothing. `countsTowardPage` owns both
// definitions so the server and the clients can't disagree about them.

// Bounds both the floor scan and the resulting payload. A netsplit can put tens
// of thousands of joins between two sentences; past this many rows the page
// simply ships fewer renderable rows than asked and `hasMoreOlder` stays true,
// i.e. the pathological buffer degrades to today's behavior instead of shipping
// a 50 MB frame. Without it the query is unbounded on exactly the buffers that
// motivated the feature.
export const RENDERABLE_MAX_SCAN = 2000;

/**
 * A scanned mode row's change list, for the `renderable` count.
 *
 * Only mode rows carry an `extra` here (the scan's CASE sees to that), so this
 * is null for everything else. Malformed JSON reads as "no changes", which makes
 * the row count — the fail-visible direction, and the same way rowToEvent
 * tolerates it.
 */
function parseScannedModes(extra: string | null): ModeChange[] | null {
  if (!extra) return null;
  try {
    const parsed = JSON.parse(extra) as { modes?: ModeChange[] };
    return Array.isArray(parsed?.modes) ? parsed.modes : null;
  } catch (_) {
    return null;
  }
}

/** Cursor + sizing options shared by every paging entry point here. */
interface PageOptions {
  before?: number;
  afterId?: number;
  limit?: number;
  maxScan?: number;
}

/**
 * A page holding up to `limit` rows that COUNT under `unit`, plus every
 * non-counting row interleaved with them (consolidation needs the whole run to
 * summarize it accurately, and at the `chat` unit the extra rows are simply
 * dropped by the client). Oldest-first, like `listMessages`.
 *
 * `before` pages backward (id < before), `afterId` pages forward (id > afterId),
 * neither pages the newest slice — matching `listMessages`' cursor semantics so
 * the two are interchangeable at the call site.
 *
 * The result is a CONTIGUOUS id range within the buffer, exactly like today's
 * slice: `hasMoreOlder`, prepend-and-dedupe, and the `before: <oldest returned
 * id>` paging cursor all keep working untouched, and there is no way for this to
 * open a hole. That property is what makes it worth doing server-side rather
 * than having clients over-fetch and trim.
 *
 * Two indexed reads, both on idx_messages_unread(network_id, target, id DESC, ...):
 * a (id, type) scan to find the boundary row, then a fetch of the range it
 * bounds.
 */
export function listMessagesCounted(
  networkId: number,
  target: string,
  unit: PageUnit,
  opts: PageOptions = {},
): MessageEvent[] {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return [];
  return listMessagesCountedById(bufferId, unit, opts);
}

function listMessagesCountedById(
  bufferId: number,
  unit: PageUnit,
  { before, afterId, limit = 100, maxScan = RENDERABLE_MAX_SCAN }: PageOptions = {},
): MessageEvent[] {
  // 'event' counts every stored row, which is precisely what the plain cursor
  // pager already does — no scan pass needed.
  if (unit === 'event') return listMessagesById(bufferId, { before, afterId, limit });

  const forward = afterId != null && afterId > 0;

  // Step 1: walk out from the cursor and stop at whichever comes first — the
  // `limit`-th COUNTING row, or `maxScan` rows.
  // `extra` comes back only for mode rows: it is the one type whose countability
  // depends on its contents (member-status churn folds, a ban doesn't), and
  // pulling the column for every scanned row would cost bytes on a scan bounded
  // at RENDERABLE_MAX_SCAN for no gain.
  const cols = `id, type, CASE WHEN type = 'mode' THEN extra END AS extra`;
  const scanSql = forward
    ? `SELECT ${cols} FROM messages WHERE buffer_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
    : before
      ? `SELECT ${cols} FROM messages WHERE buffer_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
      : `SELECT ${cols} FROM messages WHERE buffer_id = ? ORDER BY id DESC LIMIT ?`;
  const cursor = forward ? afterId : before;
  const scanParams: Array<number | string> = cursor
    ? [bufferId, cursor, maxScan]
    : [bufferId, maxScan];
  const scanned = db.prepare(scanSql).all(...scanParams) as Array<{
    id: number;
    type: string;
    extra: string | null;
  }>;
  if (scanned.length === 0) return [];

  // The last row to include. Landing ON the `limit`-th counting row (rather
  // than past it) leaves any adjacent noise for the NEXT page, where it will be
  // consolidated with the rest of its run instead of dangling.
  let boundary = scanned[scanned.length - 1].id;
  let counted = 0;
  for (const row of scanned) {
    if (!countsTowardPage({ type: row.type, modes: parseScannedModes(row.extra) }, unit)) continue;
    counted += 1;
    if (counted === limit) {
      boundary = row.id;
      break;
    }
  }

  // Step 2: ship the whole contiguous range, noise included.
  const conds = ['buffer_id = ?'];
  const params: Array<number | string> = [bufferId];
  if (forward) {
    conds.push('id > ?', 'id <= ?');
    params.push(afterId as number, boundary);
  } else {
    conds.push('id >= ?');
    params.push(boundary);
    if (before) {
      conds.push('id < ?');
      params.push(before);
    }
  }
  const rows = db
    .prepare(
      `SELECT *, ${BOOKMARKED_COL('messages')}, ${REACTIONS_COL('messages')} FROM messages WHERE ${conds.join(' AND ')} ORDER BY id ASC`,
    )
    .all(...params) as MessageRow[];
  return rows.map(rowToEvent);
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
  // Sizes each SIDE in the caller's unit (#10). Matters more here than the name
  // "jump" suggests: a client entering a buffer with a pending jump — a push
  // notification, a highlight, jump-to-first-unread — hydrates from this slice
  // and nothing else, so on a channel back from a netsplit an event-counted
  // window is the same near-blank screenful the feature exists to remove.
  countBy: PageUnit = 'event',
):
  | { events: MessageEvent[]; hasMoreOlder: boolean; hasMoreNewer: boolean }
  | { events: []; hasMoreOlder: false; hasMoreNewer: false; anchorMissing: true } {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  const anchorRow =
    bufferId === undefined
      ? undefined
      : (db
          .prepare(
            `SELECT *, ${BOOKMARKED_COL('messages')}, ${REACTIONS_COL('messages')} FROM messages WHERE id = ? AND buffer_id = ?`,
          )
          .get(anchorId, bufferId) as MessageRow | undefined);
  if (bufferId === undefined || !anchorRow) {
    return { events: [], hasMoreOlder: false, hasMoreNewer: false, anchorMissing: true };
  }
  const older = listMessagesCountedById(bufferId, countBy, {
    before: anchorId,
    limit: halfLimit,
  });
  const newer = listMessagesCountedById(bufferId, countBy, {
    afterId: anchorId,
    limit: halfLimit,
  });
  const events = [...older, rowToEvent(anchorRow), ...newer];
  const oldestId = events[0].id as number;
  const newestId = events[events.length - 1].id as number;
  return {
    events,
    hasMoreOlder: hasOlderThanById(bufferId, oldestId),
    hasMoreNewer: hasNewerThanById(bufferId, newestId),
  };
}

// Cheap edge-exists probes for the around/before/after handlers. Using a
// LIMIT 1 EXISTS-shaped query (rather than COUNT(*)) keeps this O(index seek)
// regardless of how much history is in the buffer.
function hasOlderThanById(bufferId: number, id: number): boolean {
  return !!db
    .prepare(`SELECT 1 FROM messages WHERE buffer_id = ? AND id < ? LIMIT 1`)
    .get(bufferId, id);
}

function hasNewerThanById(bufferId: number, id: number): boolean {
  return !!db
    .prepare(`SELECT 1 FROM messages WHERE buffer_id = ? AND id > ? LIMIT 1`)
    .get(bufferId, id);
}

// Public wrappers so wsHub can compute hasMoreOlder/Newer for the 'before',
// 'after', and 'latest' modes without re-declaring the SQL there.
export function hasOlderRow(networkId: number, target: string, id: number): boolean {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  return bufferId === undefined ? false : hasOlderThanById(bufferId, id);
}
export function hasNewerRow(networkId: number, target: string, id: number): boolean {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  return bufferId === undefined ? false : hasNewerThanById(bufferId, id);
}

// Are there MORE than `count` rows newer than `afterId` in this buffer? Answers
// buildResumeSlice's "did the gap overflow the cap?" question without reading the
// gap body: the caller used to fetch all `count` rows, decorate them, discover the
// overflow from their length, and throw every one away before re-reading a latest
// slice. On a flooding account every buffer overflows after any real disconnect,
// so that discarded read was the dominant cost of a resume snapshot.
//
// OFFSET, not id arithmetic: message ids are a single GLOBAL sequence shared by
// every buffer, so `afterId + count` says nothing about how many rows THIS buffer
// holds in that span. The offset walks the buffer's own rows. Selecting only `id`
// keeps it inside idx_messages_unread (index-only, no table fetches), so the probe
// costs a bounded index walk instead of `count` random row reads.
export function hasMoreThan(
  networkId: number,
  target: string,
  afterId: number,
  count: number,
): boolean {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return false;
  return !!db
    .prepare(
      `SELECT 1 FROM (
         SELECT id FROM messages
         WHERE buffer_id = ? AND id > ?
         ORDER BY id ASC LIMIT 1 OFFSET ?
       )`,
    )
    .get(bufferId, afterId, count);
}

// --- IRCv3 draft/chathistory window queries --------------------------------

// Only replayable conversation rows count toward a chathistory window/limit:
// joins/parts/quits/nick/mode/topic events and mirrored server-buffer dupes are
// excluded, so a `limit` of N yields up to N real messages (a window full of a
// netsplit's QUITs must not come back as an empty batch — that would make a
// client think it reached the start of history and stop paging). Matches what
// playbackLines will actually emit onto the wire.
const chathistoryMsgFilter = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return `${p}type IN ('message', 'action', 'notice') AND ${p}mirrored = 0 AND ${p}text IS NOT NULL AND ${p}text != ''`;
};

// The event rows a draft/event-playback client also gets in history, as soju
// replays them: joins, parts, quits, nick changes, kicks, and mode and topic
// changes. Not chghost or invite rows: soju keeps neither, and the spec's list
// names neither.
export const HISTORY_EVENT_TYPES = ['join', 'part', 'quit', 'nick', 'kick', 'mode', 'topic'];

// Who a history window is for. `me` is our current nick on the network.
export interface HistoryEvents {
  me: string | null;
}

// foldTargetWith as an SQL function, so a nick stored in a row folds exactly as
// the network folds nicks (#707): ASCII, rfc1459's [ ] \\ ^ pairs, or Unicode
// for rfc7613 and an undeclared mapping. SQLite's own lower() is ASCII-only.
const FOLD_NICK_FN = 'lurker_fold_nick';
db.function(FOLD_NICK_FN, { deterministic: true }, (mapping: unknown, nick: unknown) =>
  typeof nick === 'string'
    ? foldTargetWith(typeof mapping === 'string' ? (mapping as Casemapping) : null, nick)
    : null,
);

// The rows a window holds: messages, and for a draft/event-playback client the
// event rows too, every one counting toward the limit as soju's do. Filtered
// here rather than at playback, because a batch shorter than its limit reads as
// the start of history to halloy and gamja.
//
// Events naming our current nick stay out: a JOIN, PART, QUIT or NICK from it,
// or a KICK of it, compared under the network's CASEMAPPING as clients compare
// (goguma's isMyNick), so `foo{bar}` is `foo[bar]` on rfc1459 and `Älice` is
// `älice` on rfc7613. goguma applies every replayed line to its live state
// (client_controller.dart:577-721), and those are the ones it takes as ours: an
// old PART marks the channel as left, an old NICK renames us. HexDroid rejoins
// on an old JOIN of ours. An event under a nick we no longer use reads as
// someone else's there. The rest still reach goguma's state as they do from
// soju: an old TOPIC or MODE, or someone else's JOIN, PART or QUIT, until its
// next NAMES or TOPIC. The operator accepted that (plan: draft/event-playback).
function historyFilter(
  alias: string,
  events: HistoryEvents | null | undefined,
  mapping: Casemapping | null,
): { sql: string; params: Array<string | null> } {
  const messages = chathistoryMsgFilter(alias);
  if (!events) return { sql: messages, params: [] };
  const p = alias ? `${alias}.` : '';
  const types = HISTORY_EVENT_TYPES.map((t) => `'${t}'`).join(', ');
  let eventSql = `${p}type IN (${types})`;
  const params: Array<string | null> = [];
  if (events.me) {
    // COALESCE, or a row with no nick would compare NULL and drop out too.
    const nick = `${FOLD_NICK_FN}(?, COALESCE(${p}nick, ''))`;
    const kicked = `${FOLD_NICK_FN}(?, COALESCE(CASE WHEN json_valid(${p}extra) THEN json_extract(${p}extra, '$.kicked') END, ''))`;
    eventSql += ` AND NOT (${p}type IN ('join', 'part', 'quit', 'nick') AND ${nick} = ?)`;
    eventSql += ` AND NOT (${p}type = 'kick' AND ${kicked} = ?)`;
    const me = foldTargetWith(mapping, events.me);
    params.push(mapping, me, mapping, me);
  }
  return { sql: `((${messages}) OR (${eventSql}))`, params };
}

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
  {
    newestFirst = false,
    events: forEvents,
  }: { newestFirst?: boolean; events?: HistoryEvents | null } = {},
): MessageEvent[] {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return [];
  const filter = historyFilter('', forEvents, forEvents?.me ? networkCasemapping(networkId) : null);
  const conds = ['buffer_id = ?', filter.sql];
  const params: (string | number | null)[] = [bufferId, ...filter.params];
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
      `SELECT *, ${BOOKMARKED_COL('messages')} FROM messages WHERE ${conds.join(' AND ')}
       ORDER BY time ${dir}, id ${dir} LIMIT ?`,
    )
    .all(...params) as MessageRow[];
  const events = rows.map(rowToEvent);
  return newestFirst ? events.toReversed() : events;
}

// The newest `limit` conversation rows in a buffer, oldest first: the rows a
// chathistory window counts, for the bouncer's attach playback, so a buffer's
// joins and parts don't use up its share. In id order, down
// idx_messages_buf_unread, which carries `type`: it reads the rows it returns and
// the events it passes on the way. A window in time order reads and sorts every
// row in the buffer, once per buffer on every attach.
export function listRecentMessages(
  networkId: number,
  target: string,
  limit: number,
): MessageEvent[] {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return [];
  const rows = db
    .prepare(
      `SELECT *, ${BOOKMARKED_COL('messages')} FROM messages
        WHERE buffer_id = ? AND ${chathistoryMsgFilter()}
        ORDER BY id DESC LIMIT ?`,
    )
    .all(bufferId, limit) as MessageRow[];
  return rows.map(rowToEvent).toReversed();
}

// Buffers with real message activity inside a time window (exclusive), newest
// first, for CHATHISTORY TARGETS. Excludes :server: pseudo-buffers and applies
// the same filter as a window: a buffer whose only in-window rows are JOINs isn't
// "active", except to a draft/event-playback client (soju). The two bounds may
// arrive in either order; we normalize.
export function listActiveTargetsInWindow(
  networkId: number,
  isoA: string,
  isoB: string,
  limit: number,
  { events }: { events?: HistoryEvents | null } = {},
): BufferSummary[] {
  const [lo, hi] = isoA <= isoB ? [isoA, isoB] : [isoB, isoA];
  const filter = historyFilter('m', events, events?.me ? networkCasemapping(networkId) : null);
  // Grouped by buffer_id and named from the registry row, so the summary
  // carries the canonical casing rather than whichever casing the window's
  // rows happened to arrive under. Sentinels are excluded by kind — the
  // registry's classification, not a name-shape LIKE.
  //
  // ⚠ And by SHAPE, not just kind: #528 was public and minted `=nick` rows as
  // kind 'dm' (it predates the 'dcc' kind), so an install that ever ran it has
  // rows the kind filter alone would hand straight to bouncer clients and MCP.
  //
  // ⚠ 'dcc' is excluded for a different reason than the sentinels: this feeds
  // the bouncer's CHATHISTORY TARGETS, and a `=nick` target advertised there is
  // one an attached client will happily open a query on and then PRIVMSG — a
  // name that must never reach the wire. A DCC chat is a live socket this
  // process owns, not account state to mirror to other clients.
  return db
    .prepare(
      `SELECT b.target AS target, MAX(m.time) AS lastMessageAt
         FROM messages m
         JOIN buffers b ON b.id = m.buffer_id
        WHERE b.network_id = ?
          AND b.kind NOT IN ('server', 'system', 'dcc')
          AND substr(b.target, 1, 1) <> '='
          AND ${filter.sql}
          AND m.time > ? AND m.time < ?
        GROUP BY b.id
        ORDER BY lastMessageAt DESC
        LIMIT ?`,
    )
    .all(networkId, ...filter.params, lo, hi, limit) as BufferSummary[];
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

// Distinct buffer targets (channels/DMs/:server:) that have history on a
// network — the sidebar's buffer list. Enumerated from the registry with an
// existence probe per row: O(buffers) index seeks against the head of each
// buffer's idx_messages_buf_unread run. This retires the recursive skip-scan
// workaround that used to live here — the loose-index-scan CTE existed only
// because "which buffers exist" had to be derived from the messages table.
const listBufferTargetsStmt = db.prepare(`
  SELECT target FROM buffers b
  WHERE b.network_id = ?
    AND EXISTS (SELECT 1 FROM messages m WHERE m.buffer_id = b.id)
  ORDER BY target
`);
export function listBufferTargets(networkId: number): string[] {
  return (listBufferTargetsStmt.all(networkId) as Array<{ target: string }>).map((r) => r.target);
}

// Per-(network, target) summary for the MCP list_buffers verb and the bouncer's
// DM playback. Aggregates every buffer that has at least one message, with the
// freshest message timestamp. Sentinel buffers are filtered by kind so they
// never leak into the agent-facing surface; clients reach them via the snapshot
// only. 'dcc' is filtered for the same reason it is in listActiveTargetsInWindow
// — neither an agent nor an attached IRC client may be handed a `=nick` target.
export function listBuffersForNetwork(networkId: number): BufferSummary[] {
  return db
    .prepare(
      `SELECT b.target AS target, MAX(m.time) AS lastMessageAt
         FROM buffers b
         JOIN messages m ON m.buffer_id = b.id
        WHERE b.network_id = ?
          AND b.kind NOT IN ('server', 'system', 'dcc')
          AND substr(b.target, 1, 1) <> '='
        GROUP BY b.id
        ORDER BY lastMessageAt DESC`,
    )
    .all(networkId) as BufferSummary[];
}

// (target, max_id) per buffer in this network. Used by /mark-all-read so the
// server can clamp every buffer's read pointer to its tail in one pass. The
// correlated MAX is the first entry of each buffer's `id DESC` index run —
// O(buffers) seeks, where the old GROUP BY scanned the network's whole
// message partition.
export function maxIdByBuffer(networkId: number): MaxIdByBufferRow[] {
  return db
    .prepare(
      `SELECT target, maxId FROM (
         SELECT b.target AS target,
                (SELECT MAX(m.id) FROM messages m WHERE m.buffer_id = b.id) AS maxId
         FROM buffers b
         WHERE b.network_id = ?
       ) WHERE maxId IS NOT NULL`,
    )
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
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return 0;
  const row = db
    .prepare('SELECT MAX(id) AS maxId FROM messages WHERE buffer_id = ?')
    .get(bufferId) as { maxId: number | null } | undefined;
  return row?.maxId || 0;
}

// The time of the newest row at or below a read pointer, or null when there is
// none. MARKREAD carries a time where the pointer is an id (bouncer.ts), and the
// pointer's own row may have been pruned since, so the row below it stands in.
export function readMarkerTime(
  networkId: number,
  target: string,
  lastReadId: number,
): string | null {
  if (!(lastReadId > 0)) return null;
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return null;
  const row = db
    .prepare('SELECT time FROM messages WHERE buffer_id = ? AND id <= ? ORDER BY id DESC LIMIT 1')
    .get(bufferId, lastReadId) as { time: string } | undefined;
  return row?.time ?? null;
}

// How far a buffer's times may run out of order. Rows get ids in arrival order,
// but their times come from the network's servers and from Lurker's own clock,
// which can disagree. newestIdAtOrBefore is exact while no row's time is more
// than this far behind an earlier row's.
const READ_MARKER_SKEW_MS = 60_000;

// Where a MARKREAD's time puts the read pointer: the newest row above `afterId`
// whose time is at or before `iso`, or 0 when there is none.
//
// messages.time has no index, so walking the whole buffer down from its tail
// reads a table row per step: for a buffer far behind its pointer, every unread
// row, on the one shared connection. Instead:
// - Bisect the buffer's ids for the last row at or before `iso` plus the skew,
//   one index seek a step. No row above one later than that can be at or before
//   `iso`, so nothing the bisection skips is the answer.
// - Walk down from there to the first row at or before `iso`. That reads only
//   rows within twice the skew of `iso`.
export function newestIdAtOrBefore(
  networkId: number,
  target: string,
  afterId: number,
  iso: string,
): number {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return 0;
  const tail = db
    .prepare('SELECT MAX(id) AS maxId FROM messages WHERE buffer_id = ?')
    .get(bufferId) as { maxId: number | null } | undefined;
  const newestIn = db.prepare(
    'SELECT id, time FROM messages WHERE buffer_id = ? AND id > ? AND id <= ? ORDER BY id DESC LIMIT 1',
  );
  // Past year 9999 an ISO string gains a `+` and sorts before every stored time.
  const boundMs = Math.min(
    Date.parse(iso) + READ_MARKER_SKEW_MS,
    Date.UTC(9999, 11, 31, 23, 59, 59, 999),
  );
  const bound = new Date(boundMs).toISOString();
  const floor = Math.max(0, afterId);
  // Nothing above `hi` is at or before `iso`.
  let lo = floor;
  let hi = tail?.maxId ?? 0;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    const row = newestIn.get(bufferId, lo, mid) as { id: number; time: string } | undefined;
    if (row && row.time > bound) hi = row.id - 1;
    else lo = mid;
  }
  const row = db
    .prepare(
      'SELECT id FROM messages WHERE buffer_id = ? AND id > ? AND id <= ? AND time <= ? ORDER BY id DESC LIMIT 1',
    )
    .get(bufferId, floor, lo, iso) as { id: number } | undefined;
  return row?.id ?? 0;
}

// Cheap "does the user have any history with this target?" check used by the
// no_such_nick router: only route a DM-shaped error into a per-nick buffer if
// the user has actually conversed with that nick. Stops typo /whois replies
// from spawning empty DM buffers.
//
// These two used to be `target = ? COLLATE NOCASE` — the one predicate shape
// in this file that defeated the index prefix and scanned the network's whole
// partition. Resolution now folds through the registry, so they're index-only
// seeks, and the case-insensitivity is the registry's (foldTarget), not
// SQLite's ASCII NOCASE.
export function hasMessageForTarget(networkId: number, target: string): boolean {
  if (!networkId || !target) return false;
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return false;
  return !!db.prepare('SELECT 1 FROM messages WHERE buffer_id = ? LIMIT 1').get(bufferId);
}

// Whether this message is already stored: the same msgid in the same buffer,
// with the same kind, sender and text (IrcConnection.alreadyPersisted). A server
// can send a message twice. The buffer, sender and text have to match too, so a
// server that reuses a msgid for a different message loses nothing. A seek on
// idx_messages_msgid: `+buffer_id` keeps the planner off the per-buffer index,
// which would walk the buffer.
const sameMessageStmt = db.prepare(
  `SELECT 1 FROM messages
   WHERE network_id = ? AND msgid = ?
     AND +buffer_id = ? AND type = ? AND nick IS ? AND text IS ?
   LIMIT 1`,
);
export function hasSameMessageWithMsgid(
  networkId: number,
  target: string,
  msgid: string,
  type: string,
  nick: string | null,
  text: string | null,
): boolean {
  if (!networkId || !target || !msgid) return false;
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return false;
  return !!sameMessageStmt.get(networkId, msgid, bufferId, type, nick, text);
}

// Whether a msgid is stored anywhere on the network. The engine catch-up window
// uses this, not the buffer-scoped match: the backlog handed to the next
// process can hold, after a line the last process stored, a NICK that renamed
// that line's DM buffer, or our own NICK, which routes a notice elsewhere. The
// stored row is then no longer in the buffer its copy resolves to. A seek on
// idx_messages_msgid.
const hasMsgidStmt = db.prepare(
  'SELECT 1 FROM messages WHERE network_id = ? AND msgid = ? LIMIT 1',
);
export function hasMessageWithMsgid(networkId: number, msgid: string): boolean {
  if (!networkId || !msgid) return false;
  return !!hasMsgidStmt.get(networkId, msgid);
}

// The msgid-less version of the same question, for networks that don't tag
// messages (Libera, OFTC, ZNC…): the same target, sender, kind and text within
// a short window of the same time. Only ever consulted in the catch-up window,
// where a repeat means a re-delivery, not a user saying the same thing twice.
// By buffer, not by name: the network's casemapping folds `#foo[bar]` and
// `#foo{bar}` into one buffer, and each row keeps the spelling it arrived under.
const hasLikeStmt = db.prepare(
  `SELECT 1 FROM messages
   WHERE buffer_id = ? AND type = ? AND nick IS ? AND text IS ?
     AND time BETWEEN ? AND ? LIMIT 1`,
);
export function hasRecentMessageLike(
  networkId: number,
  target: string,
  type: string,
  nick: string | null,
  text: string | null,
  time: string,
  toleranceMs = 5000,
): boolean {
  if (!networkId || !target) return false;
  const t = Date.parse(time);
  if (!Number.isFinite(t)) return false;
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return false;
  const lo = new Date(t - toleranceMs).toISOString();
  const hi = new Date(t + toleranceMs).toISOString();
  return !!hasLikeStmt.get(bufferId, type, nick, text, lo, hi);
}

// Whether a target has a real (non-notice) conversation — at least one PRIVMSG or
// ACTION. NOTICE-only buffers (services like NickServ/ChanServ, which now get a
// buffer of their own, #439) are NOT conversations: presence-tracking keys off
// this so services don't consume MONITOR slots or show a presence dot.
export function hasConversationForTarget(networkId: number, target: string): boolean {
  if (!networkId || !target) return false;
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return false;
  return !!db
    .prepare("SELECT 1 FROM messages WHERE buffer_id = ? AND type IN ('message', 'action') LIMIT 1")
    .get(bufferId);
}

export function countOlder(networkId: number, target: string, beforeId: number): number {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return 0;
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE buffer_id = ? AND id < ?`)
      .get(bufferId, beforeId) as { n: number }
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
// LIMIT lets SQLite walk idx_messages_unread(network_id, target, id DESC, ...) and
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
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return 0;
  const lim = Number.isInteger(cap) && cap > 0 ? cap : UNREAD_COUNT_CAP;
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM messages
           WHERE buffer_id = ? AND id > ?
             AND type IN ${typesSql}
             ${notableOnly ? 'AND notable = 1' : ''}
             AND from_ignored = 0
           ORDER BY id DESC
           LIMIT ?
         )`,
      )
      .get(bufferId, afterId || 0, lim) as { n: number }
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
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return 0;
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
     WHERE buffer_id = ? AND id > ?
       AND matched_rule_id IS NOT NULL
       AND from_ignored = 0
       AND notable = 1`,
      )
      .get(bufferId, afterId || 0) as { n: number }
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
    ? `SELECT m.*, n.name AS network_name, ${BOOKMARKED_COL('m')}, ${REACTIONS_COL('m')}
       FROM messages m
       JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = ?
         AND m.matched_rule_id IS NOT NULL
         AND m.from_ignored = 0
         AND m.id < ?
       ORDER BY m.id DESC
       LIMIT ?`
    : `SELECT m.*, n.name AS network_name, ${BOOKMARKED_COL('m')}, ${REACTIONS_COL('m')}
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
// The `in:` scope's network enumeration (unscoped = "this name on any of my
// networks"); prepared once like every other statement in this module.
const userNetworkIdsStmt = db.prepare(`SELECT id FROM networks WHERE user_id = ?`);

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

  const hasText = !!text;
  if (text) {
    const match = toFtsMatch(text);
    if (!match) return [];
    // FTS5's MATCH operator must reference the virtual table by its real name,
    // not an alias — `alias MATCH ?` parses `alias` as a column.
    from += ' JOIN messages_fts ON messages_fts.rowid = m.id';
    where.push('messages_fts MATCH ?');
    params.push(match);
  }

  // `in:` resolves through the registry once per candidate network — folds
  // are per-network (#707), so ONE folded string can't probe several
  // networks: a Libera '#chat[dev]' is stored under its rfc1459 fold
  // '#chat{dev}', which a legacy fold of the query would silently miss.
  // The scoped case is the one-network instance of the same loop, so both
  // shapes share one mechanism. An empty id list matches nothing.
  let bufferIds: number[] | undefined;
  if (target) {
    const nets = networkId
      ? [{ id: networkId }]
      : (userNetworkIdsStmt.all(userId) as { id: number }[]);
    bufferIds = [];
    for (const net of nets) {
      const found = resolveBuffer(userId, net.id, target);
      if (found) bufferIds.push(found.id);
    }
  }
  const nickFiltered = nickList.length > 0 || !!nick;

  // Which predicate DRIVES a filter-only search is decided here, not left to
  // the planner: this schema never runs ANALYZE (plans stay deterministic
  // across installs), and a stats-less planner picks plausible indexes with
  // scan-shaped worst cases. Fixed priority — text > from: > in: > on: —
  // most selective in the worst case first. With free text the FTS join
  // above drives and the structured filters stay plain per-row checks.
  if (hasText) {
    if (networkId) {
      where.push('m.network_id = ?');
      params.push(networkId);
    }
  } else if (nickFiltered) {
    // Nick drives, via idx_messages_net_nick. The index needs a network_id
    // IN prefix, and the access-control join alone can't provide one — so the
    // caller's network set is pushed in as a subquery over their own rows.
    // The planner materializes it once (LIST SUBQUERY) and still seeks
    // (network_id=? AND nick=?). A subquery rather than an expanded id list
    // (PR #798 review): the set is derived inside SQL, so a request-supplied
    // networkId is ownership-checked by construction and no untrusted value
    // can reach the predicate. Still redundant with the join by design — this
    // exists purely so the planner can seek.
    if (networkId) {
      where.push('m.network_id IN (SELECT id FROM networks WHERE user_id = ? AND id = ?)');
      params.push(userId, networkId);
    } else {
      where.push('m.network_id IN (SELECT id FROM networks WHERE user_id = ?)');
      params.push(userId);
    }
  } else if (bufferIds === undefined && networkId) {
    // on:-only — idx_messages_net drives. When buffer ids are present instead,
    // NO network predicate is emitted at all: the ids above were already
    // resolved per-network, and leaving `m.network_id = ?` in tempts the
    // planner away from the buffer index into idx_messages_net, which for a
    // quiet buffer on a busy network walks the whole network's history.
    where.push('m.network_id = ?');
    params.push(networkId);
  }

  if (bufferIds !== undefined) {
    if (bufferIds.length === 0) where.push('0');
    else {
      // The unary `+` (only when nick drives) hides the buffer term from index
      // selection while keeping it as a row filter — without it the planner
      // drives from:+in: through idx_messages_buf_unread, whose worst case (a
      // nick that never spoke in a big buffer) walks the buffer's entire
      // history with a table fetch per row. Nick-driven, the wrong-buffer
      // rejects are index-only via the buffer_id payload column.
      const col = !hasText && nickFiltered ? '+m.buffer_id' : 'm.buffer_id';
      where.push(`${col} IN (${bufferIds.map(() => '?').join(', ')})`);
      params.push(...bufferIds);
    }
  }
  // `nicks` OR-matches several senders (a friend's alts); `nick` is the single
  // case. COLLATE NOCASE binds to the column so the IN comparison is case-fold
  // — and matches the collation on idx_messages_net_nick's nick column, which
  // an index without it would be invisible to.
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

  // With free text the ORDER BY targets the FTS table's rowid — the same value
  // as m.id (the join equates them), but FTS5 can stream matches in rowid
  // order natively, so the query stops at the LIMIT instead of materializing
  // and sorting every message that ever contained the term (measured 2126ms →
  // 1.6ms for a common word on a 2M-row database).
  const sql = `SELECT m.*, n.name AS network_name, ${BOOKMARKED_COL('m')}, ${REACTIONS_COL('m')}
               FROM ${from}
               WHERE ${where.join(' AND ')}
               ORDER BY ${hasText ? 'messages_fts.rowid' : 'm.id'} DESC
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
// windowed subquery on purpose: SQLite walks the tail of idx_messages_unread(
// network_id, target, id DESC, ...) applying them, so a burst of non-chat rows (a
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
    WHERE buffer_id = ?
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
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return [];
  return (
    listSpeakersStmt.all(bufferId, scanWindow, limit) as Array<{
      nick: string;
      last_time: string;
    }>
  )
    .map((r) => ({ nick: r.nick, lastTime: Date.parse(r.last_time) || 0 }))
    .filter((s) => s.lastTime > 0);
}
