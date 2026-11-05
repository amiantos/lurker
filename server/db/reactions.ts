// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { resolveBuffer } from './bufferResolve.js';
import { idInHalves } from './idInHalves.js';
import type { MessageReaction } from '../../shared/reactions.js';

// IRCv3 reactions — see the message_reactions table in db/index.ts for the
// model. A react inserts; an unreact leaves the row as a tombstone (removed_at,
// #1009), which everything showing where reactions stand must skip. How they
// reach clients: attached to message rows (REACTIONS_COL in db/messages.ts),
// plus a live `reaction` frame when one changes.

/** The stored line a reaction points at, found through its msgid. */
export interface ReactionParent {
  id: number;
  bufferId: number;
  self: boolean;
}

// The parent must be in the buffer the reaction was sent to. msgids are only
// seen by that target's members, but nothing stops someone replying with a
// msgid they learned elsewhere — scoping to the buffer keeps a reaction sent to
// #a from appearing on a line in #b. A msgid can repeat within a buffer (the
// closed-buffer NOTICE mirror; a replaying upstream): the newest copy wins,
// which is the one a reader is looking at. Not a deleted line (#1013): its
// reactions came down with it, and none goes back up.
const parentStmt = db.prepare(`
  SELECT id, buffer_id, self FROM messages
  WHERE network_id = ? AND msgid = ? AND +buffer_id = ? AND redacted_at IS NULL
  ORDER BY id DESC LIMIT 1
`);

export function findReactionParent(
  networkId: number,
  bufferId: number,
  msgid: string,
): ReactionParent | null {
  const row = parentStmt.get(networkId, msgid, bufferId) as
    | { id: number; buffer_id: number; self: number }
    | undefined;
  if (!row) return null;
  return { id: row.id, bufferId: row.buffer_id, self: row.self === 1 };
}

const insertStmt = db.prepare(`
  INSERT INTO message_reactions
    (message_id, network_id, nick, nick_folded, userhost, value, self, to_self, time)
  VALUES (@messageId, @networkId, @nick, @nickFolded, @userhost, @value, @self, @toSelf, @time)
  ON CONFLICT(message_id, nick_folded, value) DO NOTHING
`);

// An unreact leaves a tombstone (#1009): the row stays, stamped with when the
// reaction was taken back, for bouncer history to replay. Only a standing
// reaction can be taken back. Never earlier than the react: the two times can
// come from different clocks (one line's server-time, the other's arrival),
// and history replays each at its own — an unreact sorted before its react
// would leave the reaction standing on the client.
const removeStmt = db.prepare(`
  UPDATE message_reactions SET removed_at = MAX(time, ?)
  WHERE message_id = ? AND nick_folded = ? AND value = ? AND removed_at IS NULL
`);

// A react where a tombstone holds the key: the tombstone goes, and the react is
// a fresh row. A fresh id, as before tombstones, so the activity feed (paged by
// id) shows it as new and its chip goes last. The unreact it replaces leaves
// history with it, which a client needs no more: the react that follows says
// where things stand.
//
// Unless the react is older than the unreact: a replayed one (an upstream's
// playback, a stale TAGMSG) must not bring back what was since taken back. The
// tombstone is the record that it was.
const tombstoneStmt = db.prepare(`
  SELECT removed_at FROM message_reactions
  WHERE message_id = ? AND nick_folded = ? AND value = ? AND removed_at IS NOT NULL
`);
const clearTombstoneStmt = db.prepare(`
  DELETE FROM message_reactions
  WHERE message_id = ? AND nick_folded = ? AND value = ? AND removed_at IS NOT NULL
`);

export interface ReactionWrite {
  messageId: number;
  networkId: number;
  nick: string;
  userhost?: string | null;
  value: string;
  self: boolean;
  toSelf: boolean;
  time: string;
}

// Both return whether anything changed, so a repeat (the same react twice, an
// unreact for something never reacted) publishes nothing.
export const addReaction = db.transaction((r: ReactionWrite): boolean => {
  const nickFolded = r.nick.toLowerCase();
  const tombstone = tombstoneStmt.get(r.messageId, nickFolded, r.value) as
    | { removed_at: string }
    | undefined;
  if (tombstone) {
    if (r.time < tombstone.removed_at) return false;
    clearTombstoneStmt.run(r.messageId, nickFolded, r.value);
  }
  const info = insertStmt.run({
    messageId: r.messageId,
    networkId: r.networkId,
    nick: r.nick,
    nickFolded,
    userhost: r.userhost ?? null,
    value: r.value,
    self: r.self ? 1 : 0,
    toSelf: r.toSelf ? 1 : 0,
    time: r.time,
  });
  return info.changes > 0;
});

// Every reaction standing on a line, taken down at once: the line was deleted
// (#1013). Tombstones, not deletes, for the same reason an unreact leaves one —
// bouncer history replays the unreact, and a replayed react older than it
// can't bring the reaction back.
const removeAllStmt = db.prepare(`
  UPDATE message_reactions SET removed_at = MAX(time, ?)
  WHERE message_id = ? AND removed_at IS NULL
`);

/** Tombstone every standing reaction on `messageId`; returns how many went. */
export function removeAllReactions(messageId: number, time: string): number {
  return removeAllStmt.run(time, messageId).changes;
}

const removeSelfStmt = db.prepare(`
  UPDATE message_reactions SET removed_at = MAX(time, ?)
  WHERE message_id = ? AND self = 1 AND value = ? AND removed_at IS NULL
`);

// A peer's unreact matches their nick. Ours matches `self`, not the nick: we may
// have reacted as alice and be alice_ now, and the unreact echo comes from
// alice_ — keyed on the nick it would find nothing, and the reaction would stay
// ours on screen for good, every click sending another unreact that can't land.
//
// `time` is when it was taken back: the tombstone's removed_at.
export function removeReaction(
  messageId: number,
  nick: string,
  value: string,
  self: boolean,
  time: string,
): boolean {
  if (self) return removeSelfStmt.run(time, messageId, value).changes > 0;
  return removeStmt.run(time, messageId, nick.toLowerCase(), value).changes > 0;
}

// Where to send a reaction to one of the user's lines: the network, the line's
// msgid, and the buffer's CURRENT name (a DM whose peer renamed has moved;
// messages.target still holds the name the line arrived under). Null when the
// line isn't the user's, has no msgid to reply to, or was end-to-end encrypted
// — a reaction is a cleartext tag, and "lol" on an encrypted line says what the
// line was about to anyone watching the wire.
//
// Only a PRIVMSG or /me in a channel or DM buffer. Not a notice: server notices
// live in the `:server:N` pseudo-buffer, which is no IRC target, and a notice
// routed into a channel by +draft/channel-context was sent to us alone — a
// reaction to it would go to the whole channel, replying to a msgid only we
// ever saw. Not a `=nick` DCC chat either: it isn't IRC at all.
const sendTargetStmt = db.prepare(`
  SELECT m.network_id, m.msgid, m.extra, b.target, b.kind
  FROM messages m
  JOIN networks n ON n.id = m.network_id
  JOIN buffers b ON b.id = m.buffer_id
  WHERE m.id = ? AND n.user_id = ?
    AND m.type IN ('message', 'action')
    AND m.msgid IS NOT NULL AND m.msgid != ''
    AND m.redacted_at IS NULL
`);

export interface ReactionSendTarget {
  networkId: number;
  target: string;
  msgid: string;
}

export function reactionSendTarget(userId: number, messageId: number): ReactionSendTarget | null {
  const row = sendTargetStmt.get(messageId, userId) as
    | { network_id: number; msgid: string; extra: string | null; target: string; kind: string }
    | undefined;
  if (!row) return null;
  // `server` (the :server:N console) and `dcc` (=nick) are not IRC targets.
  if (row.kind !== 'channel' && row.kind !== 'dm') return null;
  if (row.extra) {
    try {
      if ((JSON.parse(row.extra) as { e2e?: unknown }).e2e) return null;
    } catch (_) {
      /* malformed extra carries no e2e flag */
    }
  }
  return { networkId: row.network_id, target: row.target, msgid: row.msgid };
}

// The reactions feed: other people's reactions to the user's own lines, newest
// reaction first. Walks idx_message_reactions_to_self_standing per network. Filters
// mirror the highlights feed's from:/in:/on: + free text, applied to the
// reaction (from: = who reacted) and the line it's on (in:, text).
export interface ReactionFeedItem {
  // The line reacted to — the jump target, as every history row's `id` is.
  id: number;
  reactionId: number;
  networkId: number;
  networkName: string;
  // The buffer's current name (a renamed DM has moved), for the jump.
  target: string;
  // Who reacted (and from where, for ignore matching), and with what.
  nick: string;
  userhost: string | null;
  value: string;
  time: string;
  // The reacted-to line's own text and time.
  text: string | null;
  messageTime: string;
}

export interface ReactionFeedOpts {
  before?: number;
  limit?: number;
  networkId?: number;
  nicks?: string[];
  target?: string;
  query?: string;
}

const userNetworkIdsStmt = db.prepare('SELECT id FROM networks WHERE user_id = ?');

// The statement listReactionsToUser runs, with its bound parameters — null
// when nothing can match. Exported so messagesEqp.test.ts pins the plan of
// the statement actually issued, across every filter combination.
//
// One half per network (idInHalves): a walk of
// idx_message_reactions_to_self_standing (network_id, id) that stops at the
// LIMIT. One statement over the caller's networks seeked that index per
// network too, but could not stream the ORDER BY across them: it fetched the
// line and buffer of every standing reaction to the user, ever, and sorted —
// on every Activity open. A half carries every filter the outer query
// applies (see idInHalves), joining messages only when a filter needs it.
export function listReactionsToUserSql(
  userId: number,
  opts: ReactionFeedOpts = {},
): { sql: string; params: unknown[] } | null {
  // The caller's own networks, narrowed to on: — a networkId that isn't
  // theirs yields no halves and no rows, ownership by construction.
  const own = (userNetworkIdsStmt.all(userId) as { id: number }[]).map((n) => n.id);
  const nets = opts.networkId ? own.filter((id) => id === opts.networkId) : own;
  if (nets.length === 0) return null;
  // `in:` resolves through the buffer registry per network, exactly as
  // searchMessages does for the highlights tab — folds are per-network (#707),
  // so one lowercased string can't stand in for an rfc1459 '#chat{dev}'.
  // Each network's buffer for in:, so a half binds only its own network's
  // (the whole list in every half grew quadratically — 181 networks hit
  // SQLite's variable limit at prepare); the page checks the full list.
  const bufferByNet = new Map<number, number>();
  if (opts.target) {
    for (const net of nets) {
      const found = resolveBuffer(userId, net, opts.target);
      if (found) bufferByNet.set(net, found.id);
    }
    if (bufferByNet.size === 0) return null;
  }
  const bufferIds = opts.target ? [...bufferByNet.values()] : undefined;
  const nicks = opts.nicks?.length ? opts.nicks.map((n) => n.toLowerCase()) : undefined;

  // The row filters, on the reaction alias `r` (and `m` for the line it
  // stands on) — ONE list, applied in every half and again on the page.
  // Standing reactions only: a tombstone was taken back (#1009).
  const conds = ['r.to_self = 1', 'r.self = 0', 'r.removed_at IS NULL'];
  const filterParams: unknown[] = [];
  if (opts.before) {
    conds.push('r.id < ?');
    filterParams.push(opts.before);
  }
  if (nicks) {
    conds.push(`r.nick_folded IN (${nicks.map(() => '?').join(', ')})`);
    filterParams.push(...nicks);
  }
  // Both sides folded by SQLite's lower(), so they agree even where it and
  // JS's toLowerCase would not (SQLite folds ASCII only).
  if (opts.query) {
    conds.push('(instr(lower(m.text), lower(?)) > 0 OR instr(lower(r.value), lower(?)) > 0)');
    filterParams.push(opts.query, opts.query);
  }
  const limit = opts.limit ?? 50;
  const needsLine = !!bufferIds || !!opts.query;
  // A half: this network's standing reactions, newest first, under the
  // shared filters plus its own in: buffer; a network without the channel
  // contributes no half.
  const half = `SELECT id FROM (
        SELECT r.id FROM message_reactions r${needsLine ? ' JOIN messages m ON m.id = r.message_id' : ''}
        WHERE r.network_id = ? AND ${[...conds, ...(bufferIds ? ['m.buffer_id = ?'] : [])].join(' AND ')}
        ORDER BY r.id DESC LIMIT ?)`;
  const halves: string[] = [];
  const params: unknown[] = [];
  for (const net of nets) {
    if (bufferIds && !bufferByNet.has(net)) continue;
    halves.push(half);
    params.push(net, ...filterParams);
    if (bufferIds) params.push(bufferByNet.get(net)!);
    params.push(limit);
  }
  const outer = bufferIds
    ? [...conds, `m.buffer_id IN (${bufferIds.map(() => '?').join(', ')})`]
    : conds;
  params.push(...filterParams, ...(bufferIds ?? []), userId, limit);
  const sql = `SELECT r.id AS reaction_id, r.nick, r.userhost, r.value, r.time,
              m.id, m.network_id, m.text, m.time AS message_time,
              b.target, n.name AS network_name
       FROM message_reactions r
       JOIN networks n ON n.id = r.network_id
       JOIN messages m ON m.id = r.message_id
       JOIN buffers b ON b.id = m.buffer_id
       WHERE ${idInHalves('r.id', halves)}
         AND ${outer.join(' AND ')}
         AND n.user_id = ?
       ORDER BY r.id DESC
       LIMIT ?`;
  return { sql, params };
}

export function listReactionsToUser(
  userId: number,
  opts: ReactionFeedOpts = {},
): ReactionFeedItem[] {
  const built = listReactionsToUserSql(userId, opts);
  if (!built) return [];
  const rows = db.prepare(built.sql).all(...built.params) as {
    reaction_id: number;
    nick: string;
    userhost: string | null;
    value: string;
    time: string;
    id: number;
    network_id: number;
    text: string | null;
    message_time: string;
    target: string;
    network_name: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    reactionId: row.reaction_id,
    networkId: row.network_id,
    networkName: row.network_name,
    target: row.target,
    nick: row.nick,
    userhost: row.userhost,
    value: row.value,
    time: row.time,
    text: row.text,
    messageTime: row.message_time,
  }));
}

// The reactions standing on a set of the user's lines, for a client re-syncing
// after a resume: a `reaction` frame only reaches sockets that were connected,
// and a resume ships only NEW rows, so a change to a line the client already
// holds is otherwise lost until a reload. Ownership is in the join — ids from
// someone else's networks simply come back with nothing.
export const MAX_REACTION_SYNC_IDS = 5000;
const SYNC_CHUNK = 500;

export function reactionsForMessages(
  userId: number,
  messageIds: number[],
): Map<number, MessageReaction[]> {
  const out = new Map<number, MessageReaction[]>();
  const ids = messageIds.slice(0, MAX_REACTION_SYNC_IDS);
  for (let i = 0; i < ids.length; i += SYNC_CHUNK) {
    const chunk = ids.slice(i, i + SYNC_CHUNK);
    const rows = db
      .prepare(
        `SELECT r.message_id, r.nick, r.value, r.self
         FROM message_reactions r
         JOIN messages m ON m.id = r.message_id
         JOIN networks n ON n.id = m.network_id
         WHERE n.user_id = ? AND r.message_id IN (${chunk.map(() => '?').join(', ')})
           AND r.removed_at IS NULL
         ORDER BY r.id`,
      )
      .all(userId, ...chunk) as { message_id: number; nick: string; value: string; self: number }[];
    for (const row of rows) {
      let list = out.get(row.message_id);
      if (!list) out.set(row.message_id, (list = []));
      list.push({ nick: row.nick, value: row.value, self: row.self === 1 });
    }
  }
  return out;
}
