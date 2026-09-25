// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { resolveBuffer } from './bufferResolve.js';

// IRCv3 reactions — see the message_reactions table in db/index.ts for the
// model. Rows hold standing state: react inserts, unreact deletes. How they
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
// which is the one a reader is looking at.
const parentStmt = db.prepare(`
  SELECT id, buffer_id, self FROM messages
  WHERE network_id = ? AND msgid = ? AND +buffer_id = ?
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
    (message_id, network_id, nick, nick_folded, value, self, to_self, time)
  VALUES (@messageId, @networkId, @nick, @nickFolded, @value, @self, @toSelf, @time)
  ON CONFLICT(message_id, nick_folded, value) DO NOTHING
`);

const deleteStmt = db.prepare(`
  DELETE FROM message_reactions
  WHERE message_id = ? AND nick_folded = ? AND value = ?
`);

export interface ReactionWrite {
  messageId: number;
  networkId: number;
  nick: string;
  value: string;
  self: boolean;
  toSelf: boolean;
  time: string;
}

// Both return whether anything changed, so a repeat (the same react twice, an
// unreact for something never reacted) publishes nothing.
export function addReaction(r: ReactionWrite): boolean {
  const info = insertStmt.run({
    messageId: r.messageId,
    networkId: r.networkId,
    nick: r.nick,
    nickFolded: r.nick.toLowerCase(),
    value: r.value,
    self: r.self ? 1 : 0,
    toSelf: r.toSelf ? 1 : 0,
    time: r.time,
  });
  return info.changes > 0;
}

const deleteSelfStmt = db.prepare(`
  DELETE FROM message_reactions WHERE message_id = ? AND self = 1 AND value = ?
`);

// A peer's unreact matches their nick. Ours matches `self`, not the nick: we may
// have reacted as alice and be alice_ now, and the unreact echo comes from
// alice_ — keyed on the nick it would find nothing, and the reaction would stay
// ours on screen for good, every click sending another unreact that can't land.
export function removeReaction(
  messageId: number,
  nick: string,
  value: string,
  self = false,
): boolean {
  if (self) return deleteSelfStmt.run(messageId, value).changes > 0;
  return deleteStmt.run(messageId, nick.toLowerCase(), value).changes > 0;
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
// reaction first. Walks idx_message_reactions_to_self per network. Filters
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
  // Who reacted, and with what.
  nick: string;
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

export function listReactionsToUser(
  userId: number,
  opts: ReactionFeedOpts = {},
): ReactionFeedItem[] {
  const conds = ['n.user_id = ?', 'r.to_self = 1', 'r.self = 0'];
  const params: unknown[] = [userId];
  if (opts.before) {
    conds.push('r.id < ?');
    params.push(opts.before);
  }
  if (opts.networkId) {
    conds.push('r.network_id = ?');
    params.push(opts.networkId);
  }
  if (opts.nicks?.length) {
    conds.push(`r.nick_folded IN (${opts.nicks.map(() => '?').join(', ')})`);
    params.push(...opts.nicks.map((n) => n.toLowerCase()));
  }
  // `in:` resolves through the buffer registry per network, exactly as
  // searchMessages does for the highlights tab — folds are per-network (#707),
  // so one lowercased string can't stand in for an rfc1459 '#chat{dev}'.
  if (opts.target) {
    const nets = opts.networkId
      ? [{ id: opts.networkId }]
      : (userNetworkIdsStmt.all(userId) as { id: number }[]);
    const bufferIds: number[] = [];
    for (const net of nets) {
      const found = resolveBuffer(userId, net.id, opts.target);
      if (found) bufferIds.push(found.id);
    }
    if (bufferIds.length === 0) return [];
    conds.push(`m.buffer_id IN (${bufferIds.map(() => '?').join(', ')})`);
    params.push(...bufferIds);
  }
  // Both sides folded by SQLite's lower(), so they agree even where it and
  // JS's toLowerCase would not (SQLite folds ASCII only).
  if (opts.query) {
    conds.push('(instr(lower(m.text), lower(?)) > 0 OR instr(lower(r.value), lower(?)) > 0)');
    params.push(opts.query, opts.query);
  }
  params.push(opts.limit ?? 50);
  const rows = db
    .prepare(
      `SELECT r.id AS reaction_id, r.nick, r.value, r.time,
              m.id, m.network_id, m.text, m.time AS message_time,
              b.target, n.name AS network_name
       FROM message_reactions r
       JOIN networks n ON n.id = r.network_id
       JOIN messages m ON m.id = r.message_id
       JOIN buffers b ON b.id = m.buffer_id
       WHERE ${conds.join(' AND ')}
       ORDER BY r.id DESC
       LIMIT ?`,
    )
    .all(...params) as {
    reaction_id: number;
    nick: string;
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
    value: row.value,
    time: row.time,
    text: row.text,
    messageTime: row.message_time,
  }));
}
