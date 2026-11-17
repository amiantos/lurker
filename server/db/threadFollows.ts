// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Reply threads the user is part of (#1225): the ones with a read pointer of
// their own, so the chip under a line can say the thread has something they
// haven't seen. A thread is (buffer, root msgid) — see messages.reply_root_msgid.
//
// Following is decided at insert (ircConnection.persist), never by opening a
// thread: posting in one, being highlighted in one (a rule, or a reply to one
// of your lines), or someone answering in a thread you started. Slack follows
// the same way.
//
// The list is state the server owns (read pointer per thread) so every tab and
// device agrees; clients get it whole in a `threads-changed` frame.

import db from './index.js';
import { HIGHLIGHTED_SQL } from './messages.js';
import { drainingInto, findAcrossDrain } from './bufferResolve.js';
import { REPLY_EXCERPT_MAX, REPLY_LINE_TYPES_SQL } from '../../shared/replies.js';
import type { FollowedThread } from '../../shared/replies.js';

export type { FollowedThread };

// A followed thread drops out of the list once it has been quiet this long
// with nothing unread in it, so the walk below stays the size of the user's
// live conversations, not everything they ever spoke in. Posting or being
// highlighted there again follows it anew.
export const THREAD_QUIET_DAYS = 7;

// Our own post reads the thread through itself: we were there. The pointer
// only ever moves forward.
const followStmt = db.prepare(`
  INSERT INTO thread_follows (user_id, buffer_id, root_msgid, read_id) VALUES (?, ?, ?, ?)
  ON CONFLICT (user_id, buffer_id, root_msgid) DO UPDATE
    SET read_id = MAX(read_id, excluded.read_id)
`);

// A follow that starts with someone else's line starts read up to (not
// including) it; one already there keeps its pointer.
const followIfAbsentStmt = db.prepare(`
  INSERT OR IGNORE INTO thread_follows (user_id, buffer_id, root_msgid, read_id)
  VALUES (?, ?, ?, ?)
`);

/** Follow a thread, read through `readId` (never moving the pointer back). */
export function followThread(
  userId: number,
  bufferId: number,
  rootMsgid: string,
  readId = 0,
): void {
  followStmt.run(userId, bufferId, rootMsgid, readId);
}

/** Follow a thread unless there's already a row. True when one was added. */
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

const isFollowedStmt = db.prepare(`
  SELECT 1 FROM thread_follows WHERE user_id = ? AND buffer_id = ? AND root_msgid = ?
`);

export function isThreadFollowed(userId: number, bufferId: number, rootMsgid: string): boolean {
  return !!isFollowedStmt.get(userId, bufferId, rootMsgid);
}

/**
 * Reply `reply` was just stored in `bufferId`'s thread `rootMsgid`: follow the
 * thread if this makes the user part of it (see the header). True when the
 * user's followed list changed — a thread joined it, or one on it has a new
 * reply or a moved pointer — so the caller can send their clients the new list.
 */
export function noteThreadReply(
  userId: number,
  bufferId: number,
  rootMsgid: string,
  reply: { id: number; self: boolean; highlighted: boolean },
): boolean {
  if (reply.self) {
    followThread(userId, bufferId, rootMsgid, reply.id);
    return true;
  }
  const joins =
    reply.highlighted ||
    !!findAcrossDrain(bufferId, (id) => rootIsTheirsStmt.get(bufferId, rootMsgid, id));
  if (joins && followThreadIfAbsent(userId, bufferId, rootMsgid, reply.id - 1)) return true;
  // Someone else's reply in a thread already listed: its count moved.
  return isThreadFollowed(userId, bufferId, rootMsgid);
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

// "Mark all read" means the threads too: every follow's pointer goes to its
// thread's newest reply. Only forward, and only rows that move, so the caller
// can tell whether there is a new list to send.
const readAllStmt = db.prepare(`
  UPDATE thread_follows SET read_id = (
    SELECT max(m.id) FROM messages m INDEXED BY idx_messages_reply_root
     WHERE m.buffer_id = thread_follows.buffer_id
       AND m.reply_root_msgid = thread_follows.root_msgid
  )
  WHERE user_id = ? AND read_id < COALESCE((
    SELECT max(m.id) FROM messages m INDEXED BY idx_messages_reply_root
     WHERE m.buffer_id = thread_follows.buffer_id
       AND m.reply_root_msgid = thread_follows.root_msgid
  ), 0)
`);

/** Every followed thread read through its newest reply. True when any moved. */
export function markAllThreadsRead(userId: number): boolean {
  return readAllStmt.run(userId).changes > 0;
}

const followsStmt = db.prepare(`
  SELECT f.buffer_id AS bufferId, f.root_msgid AS rootMsgid, f.read_id AS readId,
         b.network_id AS networkId, b.target AS target
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

// Not from someone ignored when it arrived — the list would put their words
// back on screen (the same rule as REPLY_PARENT_WHERE's); the client checks
// who's ignored since.
const rootExcerptStmt = db.prepare(`
  SELECT id, nick, type, substr(text, 1, ${REPLY_EXCERPT_MAX}) AS text, userhost FROM messages
   WHERE network_id = ? AND msgid = ? AND +buffer_id = ? AND type IN ${REPLY_LINE_TYPES_SQL}
     AND from_ignored = 0
   ORDER BY id DESC LIMIT 1
`);

/**
 * The user's followed threads: every follow that still has a reply we hold,
 * minus those quiet for THREAD_QUIET_DAYS with nothing unread. Newest activity
 * first. A few seeks per follow on the reply index.
 *
 * It also forgets what can't come back to the list: a follow whose replies
 * retention took, and one quiet past the horizon with nothing unread. Posting
 * or being highlighted there again follows it anew, so nothing is lost but the
 * row; keeping them would make this walk, run on every reply in a followed
 * thread, grow with everything the user ever followed.
 */
export function listFollowedThreads(userId: number, now = Date.now()): FollowedThread[] {
  const quietBefore = new Date(now - THREAD_QUIET_DAYS * 86_400_000).toISOString();
  const follows = followsStmt.all(userId) as Array<{
    bufferId: number;
    rootMsgid: string;
    readId: number;
    networkId: number;
    target: string;
  }>;
  const out: FollowedThread[] = [];
  for (const f of follows) {
    const last = lastReplyStmt.get(f.bufferId, f.rootMsgid) as
      | { id: number; time: string }
      | undefined;
    if (!last) {
      // Not while a merge is still moving history into the buffer (#1307):
      // the follow came over with the merge and its replies are on their way.
      // The list goes out again when they have arrived.
      if (drainingInto(f.bufferId).length > 0) continue;
      forgetStmt.run(userId, f.bufferId, f.rootMsgid); // retention took the thread
      continue;
    }
    const unread = unreadStmt.get(f.bufferId, f.rootMsgid, f.readId) as {
      n: number;
      hl: number | null;
    };
    if (unread.n === 0 && last.time < quietBefore) {
      forgetStmt.run(userId, f.bufferId, f.rootMsgid);
      continue;
    }
    const root = rootExcerptStmt.get(f.networkId, f.rootMsgid, f.bufferId) as
      | {
          id: number;
          nick: string | null;
          type: string;
          text: string | null;
          userhost: string | null;
        }
      | undefined;
    out.push({
      networkId: f.networkId,
      bufferId: f.bufferId,
      target: f.target,
      rootMsgid: f.rootMsgid,
      root: root
        ? {
            id: root.id,
            nick: root.nick ?? '',
            type: root.type,
            text: root.text ?? '',
            userhost: root.userhost ?? null,
          }
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
