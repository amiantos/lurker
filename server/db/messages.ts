// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { idInHalves } from './idInHalves.js';
import {
  resolveBuffer,
  resolveBufferIdByNetwork,
  resolveOrMintForInsert,
} from './bufferResolve.js';
import { markBufferDirty, noteNoiseInsert } from './retention.js';
import { networkCasemapping } from './buffers.js';
import { foldTargetWith } from './casemapping.js';
import { isServicesNick } from '../utils/servicesNick.js';
import type { Casemapping } from './casemapping.js';
import { EARLY_PRUNE_TYPES } from '../../shared/eventFilter.js';
import { countsTowardPage } from '../../shared/eventFilter.js';
import type { PageUnit } from '../../shared/eventFilter.js';
import type { ModeChange } from '../../shared/modes.js';
import type { MessageReaction } from '../../shared/reactions.js';
import type { Redaction } from '../../shared/redaction.js';
import { removeAllReactions } from './reactions.js';
import {
  REPLY_EXCERPT_MAX,
  REPLY_LINE_TYPES_SQL,
  THREAD_MAX_REPLIES,
} from '../../shared/replies.js';
import type {
  BufferThread,
  DraftReply,
  DraftReplyRef,
  ReplyContext,
  ReplyParent,
  ThreadStats,
} from '../../shared/replies.js';

export { THREAD_MAX_REPLIES };
export type { BufferThread };

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
  // IRCv3 replies (#993): the msgid this line answers, and whether that line is
  // one of the owner's own (from someone else) — see the columns in db/index.ts.
  reply_msgid: string | null;
  reply_to_self: number;
  // The msgid at the top of this reply's thread (see db/index.ts); rides the
  // wire as replyTo.root (#1225).
  reply_root_msgid: string | null;
  // Message redaction (#1013): when the network said this line was deleted,
  // by whom, and why — see the columns in db/index.ts. `text` is NULL then.
  redacted_at: string | null;
  redacted_by: string | null;
  redact_reason: string | null;
  // JSON object from the computed `reply_parent` column (REPLY_COL), NULL when
  // the msgid names no line we hold. Absent — not null — on reads without it.
  reply_parent?: string | null;
  // JSON object from the computed `thread` column (THREAD_COL): the replies in
  // the thread this line starts, NULL when none. Absent on reads without it.
  thread?: string | null;
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
  // A line Lurker fetched after the fact (#1283): a history backfill, or a
  // network's playback at attach. Stored and counted like any row; never a
  // push or a toast (wsHub.decorateMessage). Only on the live frame.
  replay?: boolean;
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
  // IRCv3 reply (#993): the line this one answers. Absent on a line that isn't
  // a reply, and on reads that don't resolve it (search, the bouncer) — see
  // REPLY_COL.
  replyTo?: ReplyContext;
  // The reply_to_self stamp: this line answers one of the owner's own, and so
  // is a highlight with no rule behind it. Absent when false, like `bookmarked`.
  // The stamp, not replyTo.parent — the parent can be gone or late, the stamp
  // is what every count and feed read.
  replyToSelf?: true;
  // Replies in the thread this line starts (#1225, THREAD_COL): how many and
  // when the newest arrived. Absent when none, like `bookmarked`, and on reads
  // that don't count them — the timeline reads do, as for `replyTo`.
  thread?: ThreadStats;
  // The line was deleted (#1013): `text` is null and this says when, by whom
  // and why. Absent on every other line, like `bookmarked`.
  redaction?: Redaction;
  // The msgid this line replies to, bare — only on the bouncer's history reads
  // (loadHistoryWindow, listRecentMessages), which replay it as the line's
  // +reply tag (#991). Every other read resolves it into replyTo or leaves it off.
  replyMsgid?: string;
  [key: string]: unknown;
}

// A reaction standing on a line in a history window: the bouncer replays it as
// the TAGMSG that made it (#991), in time order among the lines, as soju replays
// the reaction TAGMSGs it stores. `parentMsgid` is the network msgid of the line
// it's on, which is what the TAGMSG's reply tag names.
export interface HistoryReaction {
  type: 'reaction';
  id: number;
  time: string;
  nick: string;
  userhost: string | null;
  self: boolean;
  value: string;
  parentMsgid: string;
  // Taken back at `time` (#1009): replayed as the +draft/unreact TAGMSG.
  unreact: boolean;
}

export type HistoryRow = MessageEvent | HistoryReaction;

// MessageEvent.type is any string, so the tag alone doesn't narrow the union.
export function isHistoryReaction(row: HistoryRow): row is HistoryReaction {
  return row.type === 'reaction' && typeof (row as HistoryReaction).parentMsgid === 'string';
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
  // IRCv3 reply (#993): the msgid this line answers, and whether that's one of
  // the owner's lines (the highlight stamp — see HIGHLIGHTED_SQL).
  replyMsgid?: string | null;
  replyToSelf?: boolean;
  replyRootMsgid?: string | null;
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
  INSERT INTO messages (network_id, buffer_id, target, time, type, nick, text, kind, self, extra, matched_rule_id, userhost, from_ignored, mirrored, notable, msgid, reply_msgid, reply_to_self, reply_root_msgid, alt)
  VALUES (
    @networkId, @bufferId, @target, @time, @type, @nick, @text, @kind, @self, @extra, @matchedRuleId, @userhost, @fromIgnored, @mirrored, @notable, @msgid, @replyMsgid, @replyToSelf, @replyRootMsgid,
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
  const bufferId = resolveOrMintForInsert(row.networkId, row.target, !!row.fromIgnored);
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
    replyMsgid: row.replyMsgid || null,
    replyToSelf: row.replyToSelf ? 1 : 0,
    replyRootMsgid: row.replyRootMsgid || null,
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
// plumbing. Only on the timeline reads (pages, around, resume) — left off the
// bouncer's CHATHISTORY/playback reads (loadHistoryWindow, listRecentMessages)
// and the search/highlights/activity feeds (searchMessages), whose rows never
// render chips: there the column would be pure cost. The correlated subquery is a seek on idx_message_reactions_key
// (message_id leads it); a line nobody reacted to costs one empty probe. NULL,
// not '[]', when there are none, so rowToEvent can leave the field absent.
const REACTIONS_COL = (alias: string) => `(
    SELECT json_group_array(
      json_object('nick', r.nick, 'value', r.value, 'self', r.self) ORDER BY r.id
    )
    FROM message_reactions r
    WHERE r.message_id = ${alias}.id AND r.removed_at IS NULL
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

// A row is a highlight when a rule matched it or it answers one of the owner's
// own lines. Every highlight read uses this, so the two can never disagree about
// what counts. (countHighlightsNewer and the filter-only searchMessages path
// probe the halves separately, one partial index each — see there; the OR
// itself implies neither index.)
export const HIGHLIGHTED_SQL = (alias: string) =>
  `(${alias}.matched_rule_id IS NOT NULL OR ${alias}.reply_to_self = 1)`;

// The line a reply answers, as JSON, found by msgid in the reply's own buffer.
// Scoped to the buffer for the reason findReactionParent is: nothing stops a
// reply naming a msgid seen elsewhere, and #a's reply must not quote #b. The
// newest copy of a repeated msgid wins, as there. `+p.buffer_id` keeps the
// planner on idx_messages_msgid (network_id, msgid), which pins it to a row or
// two; the buffer check then filters those. Chat lines only (a reaction's
// TAGMSG was never stored as one), and not a line from someone ignored when it
// arrived — quoting them would put their words back on screen.
const REPLY_PARENT_JSON = `json_object(
      'id', p.id, 'nick', p.nick, 'type', p.type,
      'text', substr(p.text, 1, ${REPLY_EXCERPT_MAX}), 'userhost', p.userhost,
      'self', p.self, 'redacted', p.redacted_at IS NOT NULL
    )`;
const REPLY_PARENT_WHERE = `p.type IN ${REPLY_LINE_TYPES_SQL}
      AND p.from_ignored = 0`;

// The line a composer draft or an input-history entry replies to, by its id: the
// reply the composer would send, found as a reply's quote is (a chat line in that
// buffer, not from someone ignored) and one a reply can name (it has a msgid).
// Null when retention took it or it no longer qualifies — the draft then keeps
// its text and loses the reply. messages.id is the primary key: one seek.
// ⚠ Pass QUALIFIED columns: the subquery reads messages, so a bare `buffer_id`
// would be the message's own and the buffer check would always pass.
const DRAFT_REPLY_WHERE = `${REPLY_PARENT_WHERE} AND p.msgid IS NOT NULL AND p.msgid != ''`;
export const DRAFT_REPLY_PARENT_COL = (idCol: string, bufferCol: string) => `CASE
    WHEN ${idCol} IS NULL THEN NULL ELSE (
      SELECT ${REPLY_PARENT_JSON} FROM messages p
      WHERE p.id = ${idCol} AND p.buffer_id = ${bufferCol} AND ${DRAFT_REPLY_WHERE}
    ) END`;

// A row's draft reply, from DRAFT_REPLY_PARENT_COL and its addressed flag.
export function draftReplyFrom(
  parentJson: string | null | undefined,
  addressed: number | null | undefined,
): DraftReply | null {
  const parent = parseReplyParent(parentJson);
  return parent ? { messageId: parent.id, addressed: addressed === 1, parent } : null;
}

// One draft reply a client sent, resolved as a stored one would read back:
// what the input-history fan-out tells the user's other clients.
const draftReplyParentStmt = db.prepare(`
  SELECT ${REPLY_PARENT_JSON} AS parent FROM messages p
  WHERE p.id = ? AND p.buffer_id = ? AND ${DRAFT_REPLY_WHERE}
`);
export function resolveDraftReply(
  userId: number,
  networkId: number,
  target: string,
  ref: DraftReplyRef,
): DraftReply | null {
  if (replySendMsgid(userId, networkId, target, ref.messageId) === null) return null;
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return null;
  const row = draftReplyParentStmt.get(ref.messageId, bufferId) as { parent: string } | undefined;
  return draftReplyFrom(row?.parent, ref.addressed ? 1 : 0);
}

// Resolved at read time rather than stored, so retention taking the parent
// needs nothing kept in step: the reply just reads as unavailable. Rides the
// timeline reads like REACTIONS_COL, and search and bookmarks too (#998), so a
// reply shown out of its buffer still quotes what it answers; a line that
// isn't a reply costs the CASE and nothing else.
//
// ⚠ Only where the rows come out in index order (the timeline reads). SQLite
// computes result columns BEFORE a sorter, so on a read that sorts, this runs
// for every candidate row, not the LIMIT's worth (measured: 499 lookups for a
// 50-row bookmarks page). Those reads select it in an outer query over the
// LIMITed page instead — see withReplyCol.
export const REPLY_COL = (alias: string) => `CASE WHEN ${alias}.reply_msgid IS NULL THEN NULL ELSE (
    SELECT ${REPLY_PARENT_JSON}
    FROM messages p
    WHERE p.network_id = ${alias}.network_id AND p.msgid = ${alias}.reply_msgid
      AND +p.buffer_id = ${alias}.buffer_id AND ${REPLY_PARENT_WHERE}
    ORDER BY p.id DESC LIMIT 1
  ) END AS reply_parent`;

// The thread a line started (#1225): how many replies name it as root
// (reply_root_msgid), at any depth, and when the newest came — what the client
// draws as "3 replies · 4m" under the line and opens the thread from. Replies
// from someone ignored don't count (they mustn't be able to bump a counter on
// your line). Only a chat line with a msgid that isn't itself a reply can
// start a thread (replyRootFor roots at the top), so every other row costs the
// CASE; a candidate costs one range on the reply-only partial index —
// INDEXED BY because nothing runs ANALYZE. NULL, not an empty object, when
// there are none, so rowToEvent can leave the field absent.
//
// ⚠ Timeline reads only, for the reason REPLY_COL gives: on a sorted read it
// would run per candidate row.
const THREAD_COL = (alias: string) => `CASE
    WHEN ${alias}.msgid IS NULL OR ${alias}.reply_root_msgid IS NOT NULL
      OR ${alias}.type NOT IN ${REPLY_LINE_TYPES_SQL} THEN NULL
    ELSE (
      SELECT json_object('replies', count(*), 'lastReplyTime', max(t.time))
        FROM messages t INDEXED BY idx_messages_reply_root
       WHERE t.buffer_id = ${alias}.buffer_id AND t.reply_root_msgid = ${alias}.msgid
         AND t.from_ignored = 0
      HAVING count(*) > 0
    ) END AS thread`;

// Everything a timeline read carries beside the row itself: the reader's
// bookmark, the reactions on it, the line it answers, and the thread it starts.
const TIMELINE_COLS = (alias: string) =>
  `${BOOKMARKED_COL(alias)}, ${REACTIONS_COL(alias)}, ${REPLY_COL(alias)}, ${THREAD_COL(alias)}`;

function parseThreadCol(raw: string | null | undefined): ThreadStats | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as { replies: number; lastReplyTime: string | null };
    if (!t.replies || !t.lastReplyTime) return null;
    return { replies: t.replies, lastReplyTime: t.lastReplyTime };
  } catch (_) {
    return null;
  }
}

// The reply context for a row read with REPLY_COL. Only on reads that resolved
// it (`reply_parent` present): a reply read without it would otherwise claim its
// parent was unavailable.
// A LIMITed page read (`inner`, selecting m.* among its columns) with REPLY_COL
// added outside it, so the parent lookup runs once per row returned. The outer
// ORDER BY restores the page's order, which a subquery doesn't promise.
export function withReplyCol(inner: string): string {
  return `SELECT page.*, ${REPLY_COL('page')} FROM (${inner}) page ORDER BY page.id DESC`;
}

export function replyContextOf(row: {
  reply_msgid?: string | null;
  reply_parent?: string | null;
  reply_root_msgid?: string | null;
}): ReplyContext | undefined {
  if (!row.reply_msgid || row.reply_parent === undefined) return undefined;
  const ctx: ReplyContext = { msgid: row.reply_msgid, parent: parseReplyParent(row.reply_parent) };
  if (row.reply_root_msgid) ctx.root = row.reply_root_msgid;
  return ctx;
}

function parseReplyParent(raw: string | null | undefined): ReplyParent | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Omit<ReplyParent, 'self' | 'redacted'> & {
      self: number;
      redacted?: number;
    };
    const parent: ReplyParent = {
      id: p.id,
      nick: p.nick ?? '',
      type: p.type,
      text: p.text ?? '',
      userhost: p.userhost ?? null,
      self: p.self === 1,
    };
    if (p.redacted === 1) parent.redacted = true;
    return parent;
  } catch (_) {
    return null;
  }
}

const replyParentStmt = db.prepare(`
  SELECT ${REPLY_PARENT_JSON} AS parent
  FROM messages p
  WHERE p.network_id = ? AND p.msgid = ? AND +p.buffer_id = ? AND ${REPLY_PARENT_WHERE}
  ORDER BY p.id DESC LIMIT 1
`);

// The same lookup REPLY_COL makes, for a line being inserted now: its live
// frame needs the context the stored row will read back with, and the insert
// needs to know whether the parent is ours (reply_to_self).
export function findReplyParent(
  networkId: number,
  bufferId: number,
  msgid: string,
): ReplyParent | null {
  const row = replyParentStmt.get(networkId, msgid, bufferId) as { parent: string } | undefined;
  return row ? parseReplyParent(row.parent) : null;
}

// The parent's own root, for a reply being inserted. Unlike the quote lookup
// this takes a line from someone ignored: it's structure, not display, and
// skipping it would split their thread in two. Same buffer scope and seek.
const replyRootStmt = db.prepare(`
  SELECT reply_root_msgid AS root FROM messages
  WHERE network_id = ? AND msgid = ? AND +buffer_id = ?
    AND type IN ${REPLY_LINE_TYPES_SQL}
  ORDER BY id DESC LIMIT 1
`);

// The thread root for a reply to `parentMsgid` in `bufferId`: the parent's root
// when it is itself a reply, else the parent — including a parent we don't
// hold (gone to retention, older than our history, a reaction): as far as we
// can tell, that's where the thread starts. `bufferId` undefined = no buffer
// yet, so no parent either.
export function replyRootFor(
  networkId: number,
  bufferId: number | undefined,
  parentMsgid: string,
): string {
  if (bufferId === undefined) return parentMsgid;
  const row = replyRootStmt.get(networkId, parentMsgid, bufferId) as
    | { root: string | null }
    | undefined;
  return row?.root || parentMsgid;
}

const replySendStmt = db.prepare(`
  SELECT m.msgid FROM messages m
  JOIN networks n ON n.id = m.network_id
  WHERE m.id = ? AND n.user_id = ? AND m.network_id = ? AND m.buffer_id = ?
    AND m.type IN ${REPLY_LINE_TYPES_SQL}
    AND m.msgid IS NOT NULL AND m.msgid != ''
`);

// The msgid to put on a reply the user is sending to `target`, naming their
// stored line `messageId`. Null unless that line is theirs to see, carries a
// msgid, and sits in the very buffer the reply goes to — a reply in #b naming a
// line from #a would quote, to #b's clients, something only #a saw.
export function replySendMsgid(
  userId: number,
  networkId: number,
  target: string,
  messageId: number,
): string | null {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return null;
  const row = replySendStmt.get(messageId, userId, networkId, bufferId) as
    | { msgid: string }
    | undefined;
  return row?.msgid ?? null;
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
    matched: row.matched_rule_id != null || row.reply_to_self === 1,
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
  // And for the reply context (replyContextOf: only on reads that resolved it).
  delete event.replyTo;
  delete event.replyToSelf;
  if (row.reply_to_self === 1) event.replyToSelf = true;
  const replyTo = replyContextOf(row);
  if (replyTo) event.replyTo = replyTo;
  // And the thread it starts (THREAD_COL): only the column may say so.
  delete event.thread;
  const thread = parseThreadCol(row.thread);
  if (thread) event.thread = thread;
  // And whether it was deleted (#1013): the columns, never a stray key.
  delete event.redaction;
  if (row.redacted_at) {
    const redaction: Redaction = { by: row.redacted_by ?? '', time: row.redacted_at };
    if (row.redact_reason) redaction.reason = row.redact_reason;
    event.redaction = redaction;
  }
  return event;
}

// --- Message redaction (draft/message-redaction, #1013) ---------------------

// The line a REDACT names, in the buffer it was sent to — the same scoping rule
// as a reaction's parent (findReactionParent): a msgid is only ever seen by
// that target's members, and a repeat within a buffer resolves to the newest
// copy. Only a line someone said can be deleted (the spec: PRIVMSG, NOTICE,
// TAGMSG — and a TAGMSG is never stored as a line, so a REDACT naming a
// reaction's msgid finds nothing and is ignored, as the spec says to).
const redactTargetStmt = db.prepare(`
  SELECT id, buffer_id, nick, self, time, text FROM messages
  WHERE network_id = ? AND msgid = ? AND +buffer_id = ? AND type IN ${REPLY_LINE_TYPES_SQL}
  ORDER BY id DESC LIMIT 1
`);
const redactStmt = db.prepare(`
  UPDATE messages SET text = NULL, redacted_at = @time, redacted_by = @by, redact_reason = @reason
  WHERE id = @id AND redacted_at IS NULL
`);
// A notice to a closed DM is stored twice: its home row, and a mirror in the
// server buffer with no msgid (ircConnection's closed-buffer mirror). The REDACT
// names the home row; the mirror is the same words under the same nick at the
// same server time, and goes with it.
const mirrorRowsStmt = db.prepare(`
  SELECT id, buffer_id FROM messages
  WHERE network_id = ? AND mirrored = 1 AND redacted_at IS NULL
    AND nick IS ? AND time = ? AND text IS ?
`);

export interface RedactInput {
  networkId: number;
  bufferId: number;
  msgid: string;
  by: string;
  reason?: string | null;
  time: string;
}

/** The deleted line, for the frame that tells clients. */
export interface RedactedLine {
  id: number;
  bufferId: number;
  // The line's author, as stored, and whether it was the user's own.
  nick: string | null;
  self: boolean;
  // Server-buffer mirrors of the line (a notice to a closed DM), blanked with
  // it; each wants a frame of its own, in its buffer.
  mirrors: Array<{ id: number; bufferId: number }>;
}

// Apply a REDACT: the text goes (the FTS trigger drops it from search on the
// same write), the row says who deleted it and when, and every reaction on it
// comes down — in one transaction, so a read between the two can't see a
// deleted line still wearing its reactions. Null when the msgid names no line
// we hold in that buffer, or one already deleted (the UPDATE's own guard: a
// second REDACT for the same line — two sessions, a replay — changes nothing
// and publishes nothing).
export const redactMessage = db.transaction((r: RedactInput): RedactedLine | null => {
  const row = redactTargetStmt.get(r.networkId, r.msgid, r.bufferId) as
    | {
        id: number;
        buffer_id: number;
        nick: string | null;
        self: number;
        time: string;
        text: string | null;
      }
    | undefined;
  if (!row) return null;
  const stamp = { time: r.time, by: r.by, reason: r.reason ?? null };
  const info = redactStmt.run({ id: row.id, ...stamp });
  if (info.changes === 0) return null;
  removeAllReactions(row.id, r.time);
  const mirrors: Array<{ id: number; bufferId: number }> = [];
  if (row.text !== null) {
    const rows = mirrorRowsStmt.all(r.networkId, row.nick, row.time, row.text) as Array<{
      id: number;
      buffer_id: number;
    }>;
    for (const m of rows) {
      if (redactStmt.run({ id: m.id, ...stamp }).changes > 0) {
        mirrors.push({ id: m.id, bufferId: m.buffer_id });
      }
    }
  }
  return { id: row.id, bufferId: row.buffer_id, nick: row.nick, self: row.self === 1, mirrors };
});

// The deletions among a set of the user's lines, for a client re-syncing after
// a resume (the same reason reactionsForMessages exists): a `message-redacted`
// frame only reaches sockets that were connected, and a resume ships only new
// rows, so a line deleted while the client held it would keep its words until
// a reload. Ownership is in the join. Chunked under SQLite's variable limit.
const REDACTION_SYNC_CHUNK = 500;
export function redactionsForMessages(
  userId: number,
  messageIds: number[],
): Map<number, Redaction> {
  const out = new Map<number, Redaction>();
  for (let i = 0; i < messageIds.length; i += REDACTION_SYNC_CHUNK) {
    const chunk = messageIds.slice(i, i + REDACTION_SYNC_CHUNK);
    const rows = db
      .prepare(
        `SELECT m.id, m.redacted_at, m.redacted_by, m.redact_reason
         FROM messages m
         JOIN networks n ON n.id = m.network_id
         WHERE n.user_id = ? AND m.redacted_at IS NOT NULL
           AND m.id IN (${chunk.map(() => '?').join(', ')})`,
      )
      .all(userId, ...chunk) as Array<{
      id: number;
      redacted_at: string;
      redacted_by: string | null;
      redact_reason: string | null;
    }>;
    for (const row of rows) {
      const redaction: Redaction = { by: row.redacted_by ?? '', time: row.redacted_at };
      if (row.redact_reason) redaction.reason = row.redact_reason;
      out.set(row.id, redaction);
    }
  }
  return out;
}

// A line of the user's to send a REDACT for, by its id: the network and target
// the REDACT goes to, and the msgid it names. Null when the line isn't theirs
// to ask about (another user's network), has no msgid (an untagged network, a
// send before echo-message stamped it), sits in a buffer that isn't an IRC
// target, or is already deleted. Whether the network will ALLOW it is the
// network's answer (a FAIL), not ours: the spec says to let the user try.
const redactSendStmt = db.prepare(`
  SELECT m.network_id, m.msgid, b.target, b.kind
  FROM messages m
  JOIN networks n ON n.id = m.network_id
  JOIN buffers b ON b.id = m.buffer_id
  WHERE m.id = ? AND n.user_id = ?
    AND m.type IN ${REPLY_LINE_TYPES_SQL}
    AND m.msgid IS NOT NULL AND m.msgid != ''
    AND m.redacted_at IS NULL
`);

export interface RedactSendTarget {
  networkId: number;
  target: string;
  msgid: string;
}

export function redactSendTarget(userId: number, messageId: number): RedactSendTarget | null {
  const row = redactSendStmt.get(messageId, userId) as
    | { network_id: number; msgid: string; target: string; kind: string }
    | undefined;
  if (!row) return null;
  // `server` (the :server:N console) and `dcc` (=nick) are not IRC targets.
  if (row.kind !== 'channel' && row.kind !== 'dm') return null;
  return { networkId: row.network_id, target: row.target, msgid: row.msgid };
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
        `SELECT *, ${TIMELINE_COLS('messages')} FROM messages WHERE buffer_id = ? AND id > ?
       ORDER BY id ASC LIMIT ?`,
      )
      .all(bufferId, afterId, limit) as MessageRow[];
    return rows.map(rowToEvent);
  }
  const sql = before
    ? `SELECT *, ${TIMELINE_COLS('messages')} FROM messages WHERE buffer_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
    : `SELECT *, ${TIMELINE_COLS('messages')} FROM messages WHERE buffer_id = ? ORDER BY id DESC LIMIT ?`;
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
      `SELECT *, ${TIMELINE_COLS('messages')} FROM messages WHERE ${conds.join(' AND ')} ORDER BY id ASC`,
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
            `SELECT *, ${TIMELINE_COLS('messages')} FROM messages WHERE id = ? AND buffer_id = ?`,
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

// ─── Reply threads (#1225) ──────────────────────────────────────────────────

// A thread is read whole — the panel shows it top to bottom — so
// THREAD_MAX_REPLIES (shared/replies.ts) only bounds the frame: past it the
// NEWEST replies ship (what's being said now, and what the read pointer waits
// on) and `truncated` says so. Far beyond any conversation; a bridge that
// replies to everything can still get there.

// Most threads one `threads` read lists for a buffer, newest activity first.
export const THREADS_LIST_MAX = 50;

const threadRootStmt = db.prepare(`
  SELECT m.*, ${TIMELINE_COLS('m')} FROM messages m
   WHERE m.network_id = (SELECT network_id FROM buffers WHERE id = ?)
     AND m.msgid = ? AND +m.buffer_id = ? AND m.type IN ${REPLY_LINE_TYPES_SQL}
   ORDER BY m.id DESC LIMIT 1
`);

// INDEXED BY: the reply-only partial index holds the thread in id order, and
// nothing runs ANALYZE, so the planner could otherwise walk the buffer.
const threadRepliesStmt = db.prepare(`
  SELECT m.*, ${TIMELINE_COLS('m')} FROM messages m INDEXED BY idx_messages_reply_root
   WHERE m.buffer_id = ? AND m.reply_root_msgid = ?
   ORDER BY m.id DESC LIMIT ?
`);

/**
 * A reply thread in one buffer: the line that started it (found by msgid, the
 * newest copy, as REPLY_COL finds a parent) and every reply naming it as root,
 * oldest first (the newest `limit` of them), with the timeline columns. `root`
 * is null when we don't hold that line — retention took it, or it predates our
 * history — and the replies still come back. The caller owns the ownership
 * check on `bufferId`.
 */
export function listThread(
  bufferId: number,
  rootMsgid: string,
  limit = THREAD_MAX_REPLIES,
): { root: MessageEvent | null; replies: MessageEvent[]; truncated: boolean } {
  const rootRow = threadRootStmt.get(bufferId, rootMsgid, bufferId) as MessageRow | undefined;
  const rows = threadRepliesStmt.all(bufferId, rootMsgid, limit + 1) as MessageRow[];
  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;
  return {
    root: rootRow ? rowToEvent(rootRow) : null,
    replies: rows.map(rowToEvent).toReversed(),
    truncated,
  };
}

// One pass over the buffer's replies, grouped by thread. The partial index
// orders them (buffer, root), so each group is one run; the sort is over
// threads, not lines. Replies from someone ignored don't count, as in
// THREAD_COL. A thread whose every reply is ignored drops out.
const bufferThreadsStmt = db.prepare(`
  SELECT m.reply_root_msgid AS rootMsgid, count(*) AS replies,
         max(m.id) AS lastReplyId, max(m.time) AS lastReplyTime
    FROM messages m INDEXED BY idx_messages_reply_root
   WHERE m.buffer_id = ? AND m.reply_root_msgid IS NOT NULL AND m.from_ignored = 0
   GROUP BY m.reply_root_msgid
   ORDER BY lastReplyId DESC
   LIMIT ?
`);

// The root's excerpt: REPLY_PARENT_JSON's lookup, with the buffer scope the
// reply quote applies. Not a line from someone ignored.
const threadRootExcerptStmt = db.prepare(`
  SELECT ${REPLY_PARENT_JSON} AS parent FROM messages p
   WHERE p.network_id = (SELECT network_id FROM buffers WHERE id = ?)
     AND p.msgid = ? AND +p.buffer_id = ? AND ${REPLY_PARENT_WHERE}
   ORDER BY p.id DESC LIMIT 1
`);

/** The threads in a buffer, newest activity first: for the panel's list. */
export function listBufferThreads(bufferId: number, limit = THREADS_LIST_MAX): BufferThread[] {
  const rows = bufferThreadsStmt.all(bufferId, limit) as Array<{
    rootMsgid: string;
    replies: number;
    lastReplyId: number;
    lastReplyTime: string;
  }>;
  return rows.map((r) => {
    const root = threadRootExcerptStmt.get(bufferId, r.rootMsgid, bufferId) as
      | { parent: string }
      | undefined;
    return { ...r, root: root ? parseReplyParent(root.parent) : null };
  });
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

// isServicesNick as an SQL function, for TARGETS: our own lines to NickServ and
// friends are never replayed (they carry credentials), so they're no one's news.
const SERVICES_NICK_FN = 'lurker_is_services_nick';
db.function(SERVICES_NICK_FN, { deterministic: true }, (nick: unknown) =>
  typeof nick === 'string' && isServicesNick(nick) ? 1 : 0,
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
// time sort rides idx_messages_buf_time (buffer_id, time) — one range seek
// that stops at the LIMIT. Before that index every window walked the whole
// buffer through the id index and sorted it (#1075).
//
// `reactions` (#991): the reactions made in the window join it as rows of their
// own, in time order among the lines and counting toward the limit, as soju's
// stored reaction TAGMSGs do. A client pages on the times a batch holds —
// halloy's continue_chathistory_between starts from its first event, a
// reaction included — so a reaction must sit at its own time, not beside the
// line it's on (which could be far older).
export interface HistoryWindowOptions {
  newestFirst?: boolean;
  events?: HistoryEvents | null;
  reactions?: boolean;
  withoutSelf?: boolean;
}

// The window's message statement, with its bound parameters. Exported so
// messagesEqp.test.ts pins the plan of what actually runs, across every
// window shape (the feed plan grid).
export function loadHistoryWindowSql(
  bufferId: number,
  mapping: Casemapping | null,
  lower: string | null,
  upper: string | null,
  limit: number,
  { newestFirst = false, events: forEvents, withoutSelf = false }: HistoryWindowOptions = {},
): { sql: string; params: (string | number | null)[]; dir: 'ASC' | 'DESC' } {
  const filter = historyFilter('', forEvents, mapping);
  const conds = ['buffer_id = ?', filter.sql];
  const params: (string | number | null)[] = [bufferId, ...filter.params];
  // Our own lines, for a client the bouncer won't replay them to (a DM without
  // self-message, a services buffer): left out HERE, so they don't use up the
  // limit and hand back a short batch, which halloy and gamja read as the
  // start of history (the reason historyFilter filters in SQL too).
  if (withoutSelf) conds.push('self = 0');
  if (lower !== null) {
    conds.push('time > ?');
    params.push(lower);
  }
  if (upper !== null) {
    conds.push('time < ?');
    params.push(upper);
  }
  params.push(limit);
  // The window's direction, handed back so the reaction merge follows the
  // same one the statement used.
  const dir = newestFirst ? 'DESC' : 'ASC';
  return {
    sql: `SELECT *, ${BOOKMARKED_COL('messages')} FROM messages WHERE ${conds.join(' AND ')}
       ORDER BY time ${dir}, id ${dir} LIMIT ?`,
    params,
    dir,
  };
}

export function loadHistoryWindow(
  networkId: number,
  target: string,
  lower: string | null,
  upper: string | null,
  limit: number,
  opts: HistoryWindowOptions = {},
): HistoryRow[] {
  const { newestFirst = false, events: forEvents, reactions = false, withoutSelf = false } = opts;
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return [];
  const built = loadHistoryWindowSql(
    bufferId,
    forEvents?.me ? networkCasemapping(networkId) : null,
    lower,
    upper,
    limit,
    opts,
  );
  const dir = built.dir;
  const rows = db.prepare(built.sql).all(...built.params) as MessageRow[];
  let window: HistoryRow[] = rows.map(historyRowToEvent);
  if (reactions) {
    // The limit's worth from each, merged in the window's order: the first
    // `limit` of the merge are the first `limit` of both together.
    const reacted = loadReactionWindow(networkId, bufferId, lower, upper, limit, dir, withoutSelf);
    window = mergeHistory(window, reacted, newestFirst).slice(0, limit);
  }
  return newestFirst ? window.toReversed() : window;
}

// A history row as the bouncer replays it: with the bare msgid it replies to,
// for its +reply tag (see MessageEvent.replyMsgid).
function historyRowToEvent(row: MessageRow): MessageEvent {
  const event = rowToEvent(row);
  // Only the column may say so: rowToEvent spreads `extra`, which a stray key
  // would otherwise turn into a forged reply tag (as for replyTo, bookmarked).
  delete event.replyMsgid;
  if (row.reply_msgid) event.replyMsgid = row.reply_msgid;
  return event;
}

// A reaction the bouncer can replay: one on a line history replays with its
// msgid, since the TAGMSG's reply tag names it. So a line with a msgid, of a
// kind the window holds (chathistoryMsgFilter), and not a decrypted E2E line,
// which history replays without one (bouncer.ts networkMsgid). A reaction on a
// line the client never gets would be an orphan, and would use up the limit.
// `withoutSelf` as in loadHistoryWindow: neither our reactions nor any on our
// lines. Shared with TARGETS, so it never lists activity a window won't hold.
function replayableReactionSql(withoutSelf: boolean): string {
  const conds = [
    'm.msgid IS NOT NULL',
    chathistoryMsgFilter('m'),
    // CASE, not AND: SQLite evaluates json_extract even when json_valid is
    // false, and one malformed `extra` would throw the whole query.
    "NOT COALESCE(CASE WHEN json_valid(m.extra) THEN json_extract(m.extra, '$.e2e') END, 0)",
  ];
  if (withoutSelf) conds.push('r.self = 0', 'm.self = 0');
  return conds.join(' AND ');
}

// The reactions made in a window of one buffer, in the window's order, each
// with the msgid of the line it's on. Down idx_message_reactions_net_time: the
// network's reactions in the time range — one account's, since a network row
// is — the buffer checked on the line each is on.
function loadReactionWindow(
  networkId: number,
  bufferId: number,
  lower: string | null,
  upper: string | null,
  limit: number,
  dir: 'ASC' | 'DESC',
  withoutSelf: boolean,
): HistoryReaction[] {
  // Every reaction was made at `time`, a tombstone's included; a tombstone was
  // also taken back at `removed_at` (#1009). The limit's worth of each, merged.
  const reacts = reactionEvents(networkId, bufferId, lower, upper, limit, dir, withoutSelf, false);
  const unreacts = reactionEvents(networkId, bufferId, lower, upper, limit, dir, withoutSelf, true);
  // Oldest first: by time, a react before an unreact at the same instant (a
  // row's own react and unreact can share a millisecond), then by row.
  const rank = (e: HistoryReaction) => (e.unreact ? 1 : 0);
  const cmp = (a: HistoryReaction, b: HistoryReaction) => {
    const c = a.time < b.time ? -1 : a.time > b.time ? 1 : rank(a) - rank(b) || a.id - b.id;
    return dir === 'DESC' ? -c : c;
  };
  return [...reacts, ...unreacts].toSorted(cmp).slice(0, limit);
}

// One kind of reaction event in a window: the reacts (at `time`, down
// idx_message_reactions_net_time) or the unreacts (tombstones, at `removed_at`,
// down idx_message_reactions_net_removed). One account's network's, the buffer
// checked on the line each is on.
function reactionEvents(
  networkId: number,
  bufferId: number,
  lower: string | null,
  upper: string | null,
  limit: number,
  dir: 'ASC' | 'DESC',
  withoutSelf: boolean,
  unreacts: boolean,
): HistoryReaction[] {
  const at = unreacts ? 'r.removed_at' : 'r.time';
  const conds = ['r.network_id = ?', 'm.buffer_id = ?', replayableReactionSql(withoutSelf)];
  if (unreacts) conds.push('r.removed_at IS NOT NULL');
  const params: (string | number)[] = [networkId, bufferId];
  if (lower !== null) {
    conds.push(`${at} > ?`);
    params.push(lower);
  }
  if (upper !== null) {
    conds.push(`${at} < ?`);
    params.push(upper);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT r.id, r.nick, r.userhost, r.self, r.value, ${at} AS at, m.msgid AS parent_msgid
         FROM message_reactions r JOIN messages m ON m.id = r.message_id
        WHERE ${conds.join(' AND ')}
        ORDER BY ${at} ${dir}, r.id ${dir} LIMIT ?`,
    )
    .all(...params) as Array<{
    id: number;
    nick: string;
    userhost: string | null;
    self: number;
    value: string;
    at: string;
    parent_msgid: string;
  }>;
  return rows.map((r) => ({
    type: 'reaction',
    id: r.id,
    time: r.at,
    nick: r.nick,
    userhost: r.userhost,
    self: r.self === 1,
    value: r.value,
    parentMsgid: r.parent_msgid,
    unreact: unreacts,
  }));
}

// Two runs of history rows, each already in the window's order, merged into one.
// Only a line and a reaction are ever compared. Oldest first, a line sorts
// before a reaction at the same instant (a reaction stored in the same
// millisecond as its line comes after it), and newest first is the exact
// reverse, so a page read either way agrees about order.
function mergeHistory(
  lines: HistoryRow[],
  reacted: HistoryReaction[],
  newestFirst: boolean,
): HistoryRow[] {
  // <= 0: the line goes first.
  const cmp = (line: HistoryRow, reaction: HistoryReaction) => {
    const c = line.time < reaction.time ? -1 : line.time > reaction.time ? 1 : -1;
    return newestFirst ? -c : c;
  };
  const out: HistoryRow[] = [];
  let i = 0;
  let j = 0;
  while (i < lines.length || j < reacted.length) {
    if (j >= reacted.length || (i < lines.length && cmp(lines[i], reacted[j]) <= 0)) {
      out.push(lines[i++]);
    } else {
      out.push(reacted[j++]);
    }
  }
  return out;
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
  return rows.map(historyRowToEvent).toReversed();
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
  {
    events,
    reactions = false,
    withoutSelfInDms = false,
  }: { events?: HistoryEvents | null; reactions?: boolean; withoutSelfInDms?: boolean } = {},
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
  const buffersOnly = `b.kind NOT IN ('server', 'system', 'dcc')
          AND substr(b.target, 1, 1) <> '='`;
  // Our own lines where the bouncer never replays them — a DM, to a client that
  // takes no self-messages, or a services buffer, to anyone — are no one's news
  // either: TARGETS mustn't list a buffer, or a time, its window won't deliver.
  // The rule loadChatHistory applies per target (replaysSelfLine), per row here.
  // `?` is withoutSelfInDms.
  const selfHidden = (isSelf: string) =>
    `(b.kind = 'dm' AND (${isSelf}) AND (? OR ${SERVICES_NICK_FN}(b.target)))`;
  const hideSelf = withoutSelfInDms ? 1 : 0;
  if (!reactions) {
    return db
      .prepare(
        `SELECT b.target AS target, MAX(m.time) AS lastMessageAt
           FROM messages m
           JOIN buffers b ON b.id = m.buffer_id
          WHERE b.network_id = ?
            AND ${buffersOnly}
            AND NOT ${selfHidden('m.self = 1')}
            AND ${filter.sql}
            AND m.time > ? AND m.time < ?
          GROUP BY b.id
          ORDER BY lastMessageAt DESC
          LIMIT ?`,
      )
      .all(networkId, hideSelf, ...filter.params, lo, hi, limit) as BufferSummary[];
  }
  // A client whose windows hold reactions (#991) counts a reaction made in the
  // window as activity, as soju counts the reaction TAGMSGs it stores for an
  // event-playback client — or goguma, which asks TARGETS what changed while it
  // was away, would never fetch a buffer whose only news is a reaction. A
  // reaction is its line's buffer's; idx_message_reactions_net_time finds them.
  // Only one a window would replay (replayableReactionSql), and not our own or
  // one on our line where our lines aren't replayed (selfHidden).
  // One reaction part per kind of event: a react at `time`, an unreact at a
  // tombstone's `removed_at` (#1009, NULL on a standing reaction, so no match).
  const reactionArm = (at: string) => `         SELECT b.id, b.target, ${at}
           FROM message_reactions r
           JOIN messages m ON m.id = r.message_id
           JOIN buffers b ON b.id = m.buffer_id
          WHERE r.network_id = ?
            -- The line's buffer must be the reaction's network's, as the window
            -- finds it (its buffer resolves from the network asked about).
            -- Always so live; only an edited archive could pair them otherwise.
            AND b.network_id = r.network_id
            AND ${buffersOnly}
            AND ${replayableReactionSql(false)}
            AND NOT ${selfHidden('r.self = 1 OR m.self = 1')}
            AND ${at} > ? AND ${at} < ?`;
  return db
    .prepare(
      `SELECT target, MAX(t) AS lastMessageAt FROM (
         SELECT b.id AS bid, b.target AS target, m.time AS t
           FROM messages m
           JOIN buffers b ON b.id = m.buffer_id
          WHERE b.network_id = ?
            AND ${buffersOnly}
            AND NOT ${selfHidden('m.self = 1')}
            AND ${filter.sql}
            AND m.time > ? AND m.time < ?
         UNION ALL
${reactionArm('r.time')}
         UNION ALL
${reactionArm('r.removed_at')}
       )
       GROUP BY bid
       ORDER BY lastMessageAt DESC
       LIMIT ?`,
    )
    .all(
      networkId,
      hideSelf,
      ...filter.params,
      lo,
      hi,
      networkId,
      hideSelf,
      lo,
      hi,
      networkId,
      hideSelf,
      lo,
      hi,
      limit,
    ) as BufferSummary[];
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
// server that reuses a msgid for a different message loses nothing. A deleted
// row (#1013) has no text to match and counts anyway: an upstream replaying the
// line with its words (a bouncer's playback after a drop) must not bring back,
// beside the placeholder, what was deleted. A seek on idx_messages_msgid:
// `+buffer_id` keeps the planner off the per-buffer index, which would walk the
// buffer.
const sameMessageStmt = db.prepare(
  `SELECT 1 FROM messages
   WHERE network_id = ? AND msgid = ?
     AND +buffer_id = ? AND type = ? AND nick IS ? AND (text IS ? OR redacted_at IS NOT NULL)
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
//
// Bounded, two ways. No index covers `time`, so the unbounded form read every
// row of that type in the buffer for each line that ISN'T a repeat — nearly
// all of them — and a long detach (2.4.0's migration on a large cell) hands
// over thousands: minutes of synchronous reads, the whole process frozen.
// - `maxId`: only rows stored before this catch-up began (the connection reads
//   maxMessageId() at `attached`). A re-delivery repeats one of those; the
//   catch-up's own rows are never its original, so two identical new lines in
//   the backlog both stay.
// - `tailRows`: only the buffer's newest rows below that, where a re-delivered
//   line's original sits — it was stored just before the hand-over.
export const CATCH_UP_TAIL_ROWS = 1000;
export const HAS_LIKE_SQL = `SELECT 1 FROM (
     SELECT type, nick, text, time FROM messages
      WHERE buffer_id = @bufferId AND id <= @maxId ORDER BY id DESC LIMIT @tailRows
   )
   WHERE type = @type AND nick IS @nick AND text IS @text AND time BETWEEN @lo AND @hi LIMIT 1`;
const hasLikeStmt = db.prepare(HAS_LIKE_SQL);

export interface RepeatProbeOptions {
  toleranceMs?: number;
  /** Only rows with an id at or below this: the newest stored when the
   *  catch-up began. Unset = every row. */
  maxId?: number;
  tailRows?: number;
}

export function hasRecentMessageLike(
  networkId: number,
  target: string,
  type: string,
  nick: string | null,
  text: string | null,
  time: string,
  {
    toleranceMs = 5000,
    maxId = Number.MAX_SAFE_INTEGER,
    tailRows = CATCH_UP_TAIL_ROWS,
  }: RepeatProbeOptions = {},
): boolean {
  if (!networkId || !target) return false;
  const t = Date.parse(time);
  if (!Number.isFinite(t)) return false;
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return false;
  const lo = new Date(t - toleranceMs).toISOString();
  const hi = new Date(t + toleranceMs).toISOString();
  return !!hasLikeStmt.get({ bufferId, maxId, tailRows, type, nick, text, lo, hi });
}

// The time of the newest conversation line a buffer holds (the rows a
// CHATHISTORY window counts, chathistoryMsgFilter), or null when it holds none.
// The anchor of a history backfill (#1283): what was missed is what the
// network has after this. One seek on idx_messages_buf_time, from the newest
// end; the filter drops at most a few event rows on the way.
// `maxId` bounds it to rows stored before a point: the engine's backlog hole
// (#1283) sits between the last row the previous process stored and the
// first the backlog kept, and the kept tail is above the attach's maxMessageId.
const newestConversationStmt = db.prepare(
  `SELECT time FROM messages WHERE buffer_id = ? AND id <= ? AND ${chathistoryMsgFilter()}
   ORDER BY time DESC LIMIT 1`,
);
export function newestConversationTime(
  networkId: number,
  target: string,
  maxId = Number.MAX_SAFE_INTEGER,
): string | null {
  if (!networkId || !target) return null;
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return null;
  const row = newestConversationStmt.get(bufferId, maxId) as { time: string } | undefined;
  return row?.time ?? null;
}

// The same for every channel and DM buffer of a network, by folded target:
// the anchors of a history backfill, read in one go before the socket can
// add to any of them (a live line landing meanwhile would move an anchor
// past the whole outage). One seek per buffer, never a scan of the network's
// rows (idx_messages_net is by id, and MAX(time) over it would read them all).
const networkBuffersStmt = db.prepare(
  `SELECT id, target_folded AS target FROM buffers
   WHERE network_id = ? AND kind IN ('channel', 'dm')`,
);
export function newestConversationTimes(
  networkId: number,
  maxId = Number.MAX_SAFE_INTEGER,
): Map<string, string> {
  const anchors = new Map<string, string>();
  if (!networkId) return anchors;
  for (const { id, target } of networkBuffersStmt.all(networkId) as Array<{
    id: number;
    target: string;
  }>) {
    const row = newestConversationStmt.get(id, maxId) as { time: string } | undefined;
    if (row) anchors.set(target, row.time);
  }
  return anchors;
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
// With reply threads on (`chat.threads`, #1225) a reply lives in its thread, not
// the channel, so it counts toward the channel's badge only when it is a
// highlight — a mention, or an answer to one of the user's lines — which is
// exactly what still pulls the user in. The highlight count is unchanged, so
// highlights never exceed unread.
const THREADS_HIDDEN_SQL = `AND (reply_root_msgid IS NULL OR ${HIGHLIGHTED_SQL('messages')})`;

export interface UnreadCountOptions {
  threadsHidden?: boolean;
}

function countUnreadRows(
  networkId: number,
  target: string,
  afterId: number,
  typesSql: string,
  notableOnly: boolean,
  cap: number,
  threadsHidden = false,
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
             ${threadsHidden ? THREADS_HIDDEN_SQL : ''}
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
  opts: UnreadCountOptions = {},
): number {
  return countUnreadRows(
    networkId,
    target,
    afterId,
    COUNTABLE_TYPES_SQL,
    false,
    cap,
    !!opts.threadsHidden,
  );
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

// Cheap indexed count of unread highlights since `afterId`. Index-only on the
// partial idx_messages_matched_buf, whose payload carries every column the
// probe filters (#1073) — the old scan+decorate approach was replaced
// once match state moved to insert time. Ignored senders are excluded so the
// red highlight pip doesn't fire for someone the user can't see. notable=0 lines
// are excluded too (#470): a Lurker status notice that happens to match a self-
// nick rule ("Reclaimed nick <you>.") must not highlight the server buffer when
// it's deliberately not even counted as unread.
//
// A reply to the user counts too (HIGHLIGHTED_SQL). Two probes rather than one
// OR, so each half walks its own partial index — idx_messages_matched_buf and
// idx_messages_reply_self_buf — instead of every unread row; the second skips
// rule-matched rows so a line that is both isn't counted twice.
const countHighlightsNewerStmt = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM messages
      WHERE buffer_id = @bufferId AND id > @afterId
        AND matched_rule_id IS NOT NULL
        AND from_ignored = 0
        AND notable = 1)
  + (SELECT COUNT(*) FROM messages
      WHERE buffer_id = @bufferId AND id > @afterId
        AND reply_to_self = 1 AND matched_rule_id IS NULL
        AND from_ignored = 0
        AND notable = 1) AS n
`);

export function countHighlightsNewer(networkId: number, target: string, afterId: number): number {
  const bufferId = resolveBufferIdByNetwork(networkId, target);
  if (bufferId === undefined) return 0;
  const row = countHighlightsNewerStmt.get({ bufferId, afterId: afterId || 0 }) as { n: number };
  return row.n;
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
// via the insert-time from_ignored stamp (same as the unread counts) so an ignored user stays ignored everywhere, including for
// non-UI consumers of the search verb that have no client-side ignore filter.
//
// The `in:` scope's network enumeration (unscoped = "this name on any of my
// networks"); prepared once like every other statement in this module.
const userNetworkIdsStmt = db.prepare(`SELECT id FROM networks WHERE user_id = ?`);

// `matched: true` restricts to highlight rows (HIGHLIGHTED_SQL: a rule matched,
// or the line replies to one of the user's own) —
// this is what powers filterable highlights, which reuse the same from:/in:/on:
// + free-text machinery as search. Unlike plain search, an all-empty filter set
// is valid when `matched` is set: it means "all my highlights".
export interface SearchMessagesOptions {
  query?: string;
  networkId?: number;
  target?: string;
  nick?: string;
  nicks?: string[];
  matched?: boolean;
  before?: number;
  limit?: number;
}

// The per-row filters every search applies, on the given alias. ONE list on
// purpose: the multi-buffer in: path below LIMITs each buffer's contribution
// before the outer query filters it, so a half that admitted a row the page
// then dropped would cut that buffer's tail short — silently, on every later
// page too. Deriving both from here means they can't diverge.
const SEARCH_ROW_FILTERS = (alias: string) => [
  `${alias}.type IN ${COUNTABLE_TYPES_SQL}`,
  `${alias}.from_ignored = 0`,
  // Skip server-buffer mirror duplicates of closed-buffer NOTICEs (#439) so a
  // mirrored notice doesn't surface twice — its real copy in the sender's
  // buffer is the searchable one. Genuine server-buffer notices (mirrored = 0)
  // stay searchable.
  `${alias}.mirrored = 0`,
];

// One bounded half for idInHalves: the newest page of the rows a driver
// predicate selects, walked newest-first on whichever index serves it, under
// EXACTLY the row filters the outer page applies (see idInHalves for why).
// Every list-driven path builds its halves here, so the invariant has one
// definition. (Wrapped, because a compound select's members can't carry their
// own ORDER BY / LIMIT.) Binds: the predicate's params, then the cursor when
// `cursor`, then the LIMIT.
const pagedHalf = (predicate: string, cursor: boolean) =>
  `SELECT id FROM (
          SELECT id FROM messages h
          WHERE ${predicate} AND ${SEARCH_ROW_FILTERS('h').join(' AND ')}${cursor ? ' AND h.id < ?' : ''}
          ORDER BY h.id DESC LIMIT ?)`;

// The statement searchMessages runs, with its bound parameters — null when the
// filter set can't match anything. Exported so messagesEqp.test.ts pins the
// plan of the statement actually issued, not a copy of its shape.
export function searchMessagesSql(
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
  }: SearchMessagesOptions = {},
): { sql: string; params: (string | number)[] } | null {
  const text = typeof query === 'string' ? query.trim() : '';
  const nickList = (nicks ?? []).filter((n) => typeof n === 'string' && n);
  // Nothing to search on — no free text and no structured filter. With
  // `matched` the empty case is meaningful ("all my highlights"), so skip the
  // early-out for it.
  if (!text && !networkId && !target && !nick && nickList.length === 0 && !matched) return null;

  let from = 'messages m JOIN networks n ON n.id = m.network_id';
  const where: string[] = ['n.user_id = ?', ...SEARCH_ROW_FILTERS('m')];
  const params: (string | number)[] = [userId];

  const hasText = !!text;
  const match = hasText ? toFtsMatch(text) : '';
  if (hasText && !match) return null;

  // `in:` resolves through the registry once per candidate network — folds
  // are per-network (#707), so ONE folded string can't probe several
  // networks: a Libera '#chat[dev]' is stored under its rfc1459 fold
  // '#chat{dev}', which a legacy fold of the query would silently miss.
  // The scoped case is the one-network instance of the same loop, so both
  // shapes share one mechanism. An empty id list matches nothing.
  // The caller's own networks, narrowed to on: when given. Every path that
  // names a network derives it from here, so a request-supplied networkId
  // that isn't theirs resolves to nothing — ownership by construction (PR
  // #798 review) — and there's one place to change what "own" means.
  const own = (userNetworkIdsStmt.all(userId) as { id: number }[]).map((n) => n.id);
  const nets = networkId ? own.filter((id) => id === networkId) : own;
  // in:'s buffer on each network that holds it; the halves below seek by it.
  const bufferByNet = new Map<number, number>();
  let bufferIds: number[] | undefined;
  if (target) {
    for (const net of nets) {
      const found = resolveBuffer(userId, net, target);
      if (found) bufferByNet.set(net, found.id);
    }
    bufferIds = [...bufferByNet.values()];
  }
  const nickFiltered = nickList.length > 0 || !!nick;

  if (hasText) {
    // The word AND where to look, in one MATCH (#1302). The index carries
    // buffer_id and network_id as terms beside the text (ensureMessagesFts,
    // db/index.ts), so FTS5 intersects the posting lists and only ever hands
    // back rows inside the scope: in:'s buffers when given, else the caller's
    // networks (one, with on:). Asked for the word alone, it handed back
    // every hit on the INSTANCE, and the checks below threw the rest away
    // after a table fetch each — minutes of cold reads for a word common
    // elsewhere and rare here.
    //
    // This narrows the work; it is not the access boundary. `n.user_id = ?`
    // and the row checks below still decide what the caller may see, so an
    // index that had somehow fallen out of step could cost rows, never leak
    // them.
    //
    // A scope that holds nothing — an on: that isn't the caller's network, an
    // in: no network of theirs holds, no networks at all — has no rows to
    // find, and is answered here. Left to run on the word alone it would walk
    // every hit on the instance to return none of them.
    //
    // `text:` always, or a search for "33" would match buffer 33's every row.
    //
    // FTS5's MATCH operator must reference the virtual table by its real name,
    // not an alias — `alias MATCH ?` parses `alias` as a column.
    const scopeIds = bufferIds ?? nets;
    if (scopeIds.length === 0) return null;
    const scope = `${bufferIds ? 'buffer_id' : 'network_id'}:(${scopeIds.map((id) => `"${id}"`).join(' OR ')})`;
    from += ' JOIN messages_fts ON messages_fts.rowid = m.id';
    where.push('messages_fts MATCH ?');
    params.push(`text:(${match}) AND ${scope}`);
  }

  // Which predicate DRIVES a filter-only search is decided here, not left to
  // the planner: this schema never runs ANALYZE (plans stay deterministic
  // across installs), and a stats-less planner picks plausible indexes with
  // scan-shaped worst cases. Fixed priority — text > highlights > from: > in:
  // > on: — most selective in the worst case first. With free text the FTS
  // join above drives and the structured filters stay plain per-row checks.
  //
  // Highlights drive every filter-only `matched` read (#1070). Left to the
  // planner, the OR in HIGHLIGHTED_SQL implies neither partial index, so "all
  // my highlights" walked every message on every network through
  // idx_messages_net and sorted the lot to return 50 rows — 139s on a 2.9M-row
  // cell, long enough for every IRC connection's ping timer to expire. Instead
  // the two stamps are read the way countHighlightsNewer reads them, one probe
  // per partial index, and the ids are handed to the outer query as an IN
  // list: SQLite walks that list in id order, so the ORDER BY needs no sort
  // and the LIMIT stops the table fetches at a page's worth. Both indexes are
  // keyed (buffer_id, id DESC), so each half seeks the caller's buffers — the
  // in: ids when given, else every buffer on their networks (one network's
  // with on:) — and the list holds the CALLER's highlights, not the
  // instance's: on a multi-user host another user's 300k highlights would
  // otherwise be enumerated, and walked past, on every page. The cursor
  // rides the same seek. The reply half is index-only; the rule half fetches
  // the row to check its stamp (SQLite never drops an IS NOT NULL as implied),
  // so the list costs the caller's highlight count, never the table. INDEXED
  // BY, so a change to either index that no longer serves this fails to
  // prepare — per request here (the statement is built per call), and in CI
  // where messagesEqp.test.ts issues the real statement.
  // Which list drives, in priority order (text drives through FTS, not a list).
  const highlightDriven = !!matched && !hasText;
  const nickDriven = nickFiltered && !hasText && !highlightDriven;
  const bufferDriven = bufferIds !== undefined && !hasText && !nickFiltered && !highlightDriven;
  // Set by whichever branch builds halves: the cursor then lives inside them.
  let cursorInHalves = false;
  if (matched && !highlightDriven) {
    where.push(HIGHLIGHTED_SQL('m'));
  }
  if (highlightDriven) {
    const half: string[] = [];
    const halfParams: number[] = [];
    if (bufferIds !== undefined && bufferIds.length > 0) {
      half.push(`buffer_id IN (${bufferIds.map(() => '?').join(', ')})`);
      halfParams.push(...bufferIds);
    } else if (networkId) {
      half.push(
        `buffer_id IN (SELECT b.id FROM buffers b JOIN networks n ON n.id = b.network_id
                            WHERE n.user_id = ? AND n.id = ?)`,
      );
      halfParams.push(userId, networkId);
    } else {
      half.push(
        `buffer_id IN (SELECT b.id FROM buffers b JOIN networks n ON n.id = b.network_id
                            WHERE n.user_id = ?)`,
      );
      halfParams.push(userId);
    }
    if (before) {
      half.push('id < ?');
      halfParams.push(before);
    }
    cursorInHalves = true;
    const probe = (index: string, stamp: string) =>
      `SELECT id FROM messages INDEXED BY ${index} WHERE ${[stamp, ...half].join(' AND ')}`;
    where.push(
      `m.id IN (${probe('idx_messages_matched_buf', 'matched_rule_id IS NOT NULL')}
                UNION ALL ${probe('idx_messages_reply_self_buf', 'reply_to_self = 1')})`,
    );
    params.push(...halfParams, ...halfParams);
    // on: and from: are plain row checks over the page; with a network term
    // the planner seeks idx_messages_net by (network_id, id) per listed id,
    // which rejects the other networks' highlights in-index.
    if (networkId) {
      where.push('m.network_id = ?');
      params.push(networkId);
    }
  } else if (hasText) {
    // Hidden from index selection with the unary `+`: left visible, on: plus
    // a cursor tempted the planner off FTS onto idx_messages_net
    // (network_id=? AND id<?), walking the network's whole history below the
    // cursor with an FTS probe per row — page 2 of every scoped text search.
    if (networkId) {
      where.push('+m.network_id = ?');
      params.push(networkId);
    }
  } else if (nickDriven) {
    // Nick drives, via idx_messages_net_nick (network_id, nick, id DESC, …):
    // one half per (network, nick), each a walk of that prefix that stops at
    // the LIMIT, index-only since the row filters, buffer_id and the cursor
    // are all payload columns. The earlier single statement seeked the same
    // index through a `network_id IN (subquery)`, which can't stream the
    // ORDER BY: it gathered every line the nick ever spoke across the
    // caller's networks, fetched each row, and sorted — from:<a bot> on
    // years of history. The network list is the caller's own, filtered to
    // on: when given, so a request-supplied networkId that isn't theirs
    // yields no halves and no rows. A multi-value nick IN inside one half
    // would sort again, hence a half per nick. With in:, each half binds
    // ITS network's buffer (a payload column, rejected in-index) — a network
    // that doesn't hold the channel contributes no half.
    const senders = nickList.length > 0 ? nickList : [nick as string];
    const halves: string[] = [];
    for (const net of nets) {
      const scoped = target ? bufferByNet.get(net) : undefined;
      if (target && scoped === undefined) continue;
      for (const sender of senders) {
        halves.push(
          pagedHalf(
            `h.network_id = ? AND h.nick = ? COLLATE NOCASE${scoped === undefined ? '' : ' AND h.buffer_id = ?'}`,
            !!before,
          ),
        );
        params.push(net, sender);
        if (scoped !== undefined) params.push(scoped);
        if (before) params.push(before);
        params.push(limit);
      }
    }
    cursorInHalves = true;
    if (halves.length === 0) where.push('0');
    else where.push(idInHalves('m.id', halves));
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
    else if (bufferDriven && bufferIds.length > 1) {
      // in: alone, resolved on several networks. A multi-value `buffer_id IN`
      // can't stream `ORDER BY id DESC` across buffers, so the planner walked
      // EVERY listed buffer's whole history through idx_messages_buf_unread
      // and sorted the lot — seconds of blocked event loop for a channel the
      // user sits in on two networks. Instead each buffer contributes its own
      // newest page — a walk of idx_messages_buf_unread that stops at the
      // LIMIT, with type and from_ignored rejected in-index and a row fetch
      // for `mirrored`, which the index doesn't carry — and the outer query
      // pages the union by id as the highlight path does.
      const half = pagedHalf('h.buffer_id = ?', !!before);
      cursorInHalves = true;
      where.push(
        idInHalves(
          'm.id',
          bufferIds.map(() => half),
        ),
      );
      for (const id of bufferIds) {
        params.push(id);
        if (before) params.push(before);
        params.push(limit);
      }
    } else if (!highlightDriven) {
      // Plain row check when a half list (from:) or FTS drives; the unary `+`
      // hides it from index selection so the planner can't abandon the driver
      // for idx_messages_buf_unread. Visible only on the single-buffer in:
      // path, where that index IS the driver.
      const col = !hasText && !nickFiltered ? 'm.buffer_id' : '+m.buffer_id';
      where.push(`${col} IN (${bufferIds.map(() => '?').join(', ')})`);
      params.push(...bufferIds);
    }
  }
  // `nicks` OR-matches several senders (a friend's alts); `nick` is the single
  // case. COLLATE NOCASE binds to the column so the IN comparison is case-fold
  // — and matches the collation on idx_messages_net_nick's nick column, which
  // an index without it would be invisible to.
  // (Hidden from index selection like the buffer term: redundant with the
  // from: halves, and a bare nick term could tempt the planner elsewhere.)
  if (nickList.length > 0) {
    where.push(`+m.nick COLLATE NOCASE IN (${nickList.map(() => '?').join(', ')})`);
    params.push(...nickList);
  } else if (nick) {
    where.push('+m.nick = ? COLLATE NOCASE');
    params.push(nick);
  }
  // The cursor: inside the halves on the list-driven paths (already applied
  // there), on the FTS rowid with free text — FTS5 takes a rowid range
  // natively, so the stream starts below the cursor — and a plain index
  // range on the single-buffer / on:-only streams.
  if (before && !cursorInHalves) {
    where.push(hasText ? 'messages_fts.rowid < ?' : 'm.id < ?');
    params.push(before);
  }

  // With free text the ORDER BY targets the FTS table's rowid — the same value
  // as m.id (the join equates them), but FTS5 can stream matches in rowid
  // order natively, so the query stops at the LIMIT instead of materializing
  // and sorting every message that ever contained the term (measured 2126ms →
  // 1.6ms for a common word on a 2M-row database).
  // The page is picked first, and the reply quote added over it (withReplyCol):
  // a column computed inside the page query would run for every candidate row
  // the driver visits, not the LIMIT's worth.
  const sql = withReplyCol(`SELECT m.*, n.name AS network_name, ${BOOKMARKED_COL('m')}
               FROM ${from}
               WHERE ${where.join(' AND ')}
               ORDER BY ${hasText ? 'messages_fts.rowid' : 'm.id'} DESC
               LIMIT ?`);
  params.push(limit);
  return { sql, params };
}

export function searchMessages(
  userId: number,
  opts: SearchMessagesOptions = {},
): MessageEventWithNetwork[] {
  const built = searchMessagesSql(userId, opts);
  if (!built) return [];
  return searchRowsToEvents(db.prepare(built.sql).all(...built.params));
}

// The rows of a searchMessagesSql statement, as the events searchMessages
// returns. Apart so the statement can run elsewhere (services/searchRunner.ts
// runs it in the search process) and its rows be mapped here.
export function searchRowsToEvents(rows: unknown[]): MessageEventWithNetwork[] {
  return (rows as MessageRowWithNetwork[]).map((row) => ({
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
