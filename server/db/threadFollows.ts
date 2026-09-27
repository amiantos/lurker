// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Reply threads the user follows: the ones listed under their channel in the
// sidebar. A thread is (buffer, root msgid) — see messages.reply_root_msgid.
//
// Following is decided at insert (ircConnection.persist), never by a click:
// posting in a thread, or being highlighted in one (a rule, or a reply to one
// of your lines), follows it — and reopens it if you'd closed it. A reply in a
// thread whose first line is yours, or highlighted you, follows it too, but
// doesn't reopen one you closed: that's someone else talking in it.
//
// The list is state the server owns (read pointer, closed) so every tab and
// device agrees; clients get it whole in a `threads-changed` frame.

import db from './index.js';
import { HIGHLIGHTED_SQL } from './messages.js';
import { REPLY_EXCERPT_MAX, REPLY_LINE_TYPES_SQL } from '../../shared/replies.js';
import type { ReplyParent } from '../../shared/replies.js';

// A followed thread drops out of the list once it has been quiet this long
// with nothing unread in it. Threads are conversations; a sidebar entry for
// every one the user ever spoke in would bury the live ones. Closing (×)
// removes one sooner.
export const THREAD_QUIET_DAYS = 7;

export interface FollowedThread {
  networkId: number;
  bufferId: number;
  target: string;
  rootMsgid: string;
  // The line that started it, excerpted like a reply's quote; null when we
  // don't hold it.
  root: Omit<ReplyParent, 'userhost' | 'self'> | null;
  // Replies from others the user hasn't seen in the thread view, and whether
  // any of them is a highlight.
  unread: number;
  highlighted: boolean;
  lastReplyId: number;
  lastReplyTime: string;
}

// A follow starts read up to the moment it began: the thread's earlier
// replies are what the user joined, not news. Reopening moves the pointer the
// same way, never back.
const followStmt = db.prepare(`
  INSERT INTO thread_follows (user_id, buffer_id, root_msgid, read_id) VALUES (?, ?, ?, ?)
  ON CONFLICT (user_id, buffer_id, root_msgid) DO UPDATE
    SET closed = 0, read_id = MAX(read_id, excluded.read_id)
    WHERE closed = 1
`);

const followIfAbsentStmt = db.prepare(`
  INSERT OR IGNORE INTO thread_follows (user_id, buffer_id, root_msgid, read_id)
  VALUES (?, ?, ?, ?)
`);

/** Follow a thread, reopening it if closed, read through `readId`. True when
 *  that changed the list. */
export function followThread(
  userId: number,
  bufferId: number,
  rootMsgid: string,
  readId = 0,
): boolean {
  return followStmt.run(userId, bufferId, rootMsgid, readId).changes > 0;
}

/** Follow a thread unless there's already a row — open or closed. */
export function followThreadIfAbsent(
  userId: number,
  bufferId: number,
  rootMsgid: string,
  readId = 0,
): boolean {
  return followIfAbsentStmt.run(userId, bufferId, rootMsgid, readId).changes > 0;
}

// Whether the line that started a thread is the user's own or highlighted
// them — the root found as replyRootFor found it.
const rootIsTheirsStmt = db.prepare(`
  SELECT 1 FROM messages m
   WHERE m.network_id = (SELECT network_id FROM buffers WHERE id = ?)
     AND m.msgid = ? AND +m.buffer_id = ? AND m.type IN ${REPLY_LINE_TYPES_SQL}
     AND (m.self = 1 OR ${HIGHLIGHTED_SQL('m')})
   LIMIT 1
`);

const openFollowStmt = db.prepare(`
  SELECT 1 FROM thread_follows
   WHERE user_id = ? AND buffer_id = ? AND root_msgid = ? AND closed = 0
`);

/**
 * Reply `replyId` was just stored in `bufferId`'s thread `rootMsgid`: follow
 * the thread if this makes the user part of it (see the header). True when the
 * user's followed list changed — a thread joined it, or one already on it has
 * a new reply — so the caller can send their clients the new list. A follow
 * starts read through our own post, or up to (not including) the reply that
 * brought the user in.
 */
export function noteThreadReply(
  userId: number,
  bufferId: number,
  rootMsgid: string,
  reply: { id: number; self: boolean; highlighted: boolean },
): boolean {
  const readId = reply.self ? reply.id : reply.id - 1;
  if (reply.self || reply.highlighted) {
    if (followThread(userId, bufferId, rootMsgid, readId)) return true;
  } else if (rootIsTheirsStmt.get(bufferId, rootMsgid, bufferId)) {
    if (followThreadIfAbsent(userId, bufferId, rootMsgid, readId)) return true;
  }
  return !!openFollowStmt.get(userId, bufferId, rootMsgid);
}

const closeStmt = db.prepare(`
  UPDATE thread_follows SET closed = 1
   WHERE user_id = ? AND buffer_id = ? AND root_msgid = ? AND closed = 0
`);

/** Take a thread off the list until the user posts or is highlighted in it. */
export function closeThread(userId: number, bufferId: number, rootMsgid: string): boolean {
  return closeStmt.run(userId, bufferId, rootMsgid).changes > 0;
}

// Clamped with MAX like buffer_reads, so a stale tab can't move it back.
const readStmt = db.prepare(`
  UPDATE thread_follows SET read_id = ?
   WHERE user_id = ? AND buffer_id = ? AND root_msgid = ? AND read_id < ?
`);

/** The user has seen the thread up to `messageId`. True when that moved it. */
export function markThreadRead(
  userId: number,
  bufferId: number,
  rootMsgid: string,
  messageId: number,
): boolean {
  return readStmt.run(messageId, userId, bufferId, rootMsgid, messageId).changes > 0;
}

// Every follow, closed ones included: a closed follow is only ever cleared
// here (see listFollowedThreads). Whether the buffer is open is the client's
// to judge — it shows threads under open channel rows only, and a buffer that
// reopens has its threads there without a new list.
const followsStmt = db.prepare(`
  SELECT f.buffer_id AS bufferId, f.root_msgid AS rootMsgid, f.read_id AS readId,
         f.closed AS closed, b.network_id AS networkId, b.target AS target
    FROM thread_follows f JOIN buffers b ON b.id = f.buffer_id
   WHERE f.user_id = ?
`);

const forgetStmt = db.prepare(`
  DELETE FROM thread_follows WHERE user_id = ? AND buffer_id = ? AND root_msgid = ?
`);

// The thread's newest reply. INDEXED BY for the reason listThread gives.
const lastReplyStmt = db.prepare(`
  SELECT id, time FROM messages INDEXED BY idx_messages_reply_root
   WHERE buffer_id = ? AND reply_root_msgid = ?
   ORDER BY id DESC LIMIT 1
`);

// Unread = replies from others past the read pointer, counted the way a
// buffer's unread is: chat lines, not from someone ignored.
const unreadStmt = db.prepare(`
  SELECT count(*) AS n, max(${HIGHLIGHTED_SQL('m')}) AS hl
    FROM messages m INDEXED BY idx_messages_reply_root
   WHERE m.buffer_id = ? AND m.reply_root_msgid = ? AND m.id > ?
     AND m.self = 0 AND m.from_ignored = 0 AND m.type IN ${REPLY_LINE_TYPES_SQL}
`);

const rootExcerptStmt = db.prepare(`
  SELECT id, nick, type, substr(text, 1, ${REPLY_EXCERPT_MAX}) AS text FROM messages
   WHERE network_id = ? AND msgid = ? AND +buffer_id = ? AND type IN ${REPLY_LINE_TYPES_SQL}
   ORDER BY id DESC LIMIT 1
`);

/**
 * The user's followed threads, for the sidebar: every open follow that still
 * has a reply we hold, minus those quiet for THREAD_QUIET_DAYS with nothing
 * unread. Newest activity first. A few seeks per follow on the reply index.
 *
 * It also forgets what can't come back to the list: a follow whose replies
 * retention took, and one — open or closed — quiet past the same horizon with
 * nothing unread. Posting or being highlighted there again follows it anew, so
 * nothing is lost but the row; keeping them would make this walk, run on every
 * reply in a followed thread, grow with everything the user ever followed.
 */
export function listFollowedThreads(userId: number, now = Date.now()): FollowedThread[] {
  const quietBefore = new Date(now - THREAD_QUIET_DAYS * 86_400_000).toISOString();
  const follows = followsStmt.all(userId) as Array<{
    bufferId: number;
    rootMsgid: string;
    readId: number;
    closed: number;
    networkId: number;
    target: string;
  }>;
  const out: FollowedThread[] = [];
  for (const f of follows) {
    const last = lastReplyStmt.get(f.bufferId, f.rootMsgid) as
      | { id: number; time: string }
      | undefined;
    if (!last) {
      forgetStmt.run(userId, f.bufferId, f.rootMsgid); // retention took the thread
      continue;
    }
    const quiet = last.time < quietBefore;
    if (f.closed) {
      if (quiet) forgetStmt.run(userId, f.bufferId, f.rootMsgid);
      continue;
    }
    const unread = unreadStmt.get(f.bufferId, f.rootMsgid, f.readId) as {
      n: number;
      hl: number | null;
    };
    if (unread.n === 0 && quiet) {
      forgetStmt.run(userId, f.bufferId, f.rootMsgid);
      continue;
    }
    const root = rootExcerptStmt.get(f.networkId, f.rootMsgid, f.bufferId) as
      | { id: number; nick: string | null; type: string; text: string | null }
      | undefined;
    out.push({
      networkId: f.networkId,
      bufferId: f.bufferId,
      target: f.target,
      rootMsgid: f.rootMsgid,
      root: root
        ? { id: root.id, nick: root.nick ?? '', type: root.type, text: root.text ?? '' }
        : null,
      unread: unread.n,
      highlighted: unread.hl === 1,
      lastReplyId: last.id,
      lastReplyTime: last.time,
    });
  }
  out.sort((a, b) => b.lastReplyId - a.lastReplyId);
  return out;
}
