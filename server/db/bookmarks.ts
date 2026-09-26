// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** A bookmark event row — message fields joined with network_name. */
export interface BookmarkEvent {
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
  networkName: string;
  [key: string]: unknown;
}

/** Raw joined row from the bookmarks query. */
interface BookmarkRow {
  id: number;
  network_id: number;
  target: string;
  time: string;
  type: string;
  nick: string | null;
  text: string | null;
  kind: string | null;
  self: number;
  userhost: string | null;
  alt: number;
  matched_rule_id: number | null;
  reply_to_self: number;
  network_name: string;
  extra: string | null;
}

// Ownership-gated insert. The SELECT inside the INSERT confirms the message
// belongs to one of the caller's networks; if it doesn't, the SELECT returns
// no rows and the insert is a silent no-op. Cheaper than a separate lookup
// round-trip and atomic with the write.
const insertStmt = db.prepare(`
  INSERT INTO user_bookmarks (user_id, message_id, created_at)
  SELECT @userId, @messageId, datetime('now')
  WHERE EXISTS (
    SELECT 1 FROM messages m
    JOIN networks n ON n.id = m.network_id
    WHERE m.id = @messageId AND n.user_id = @userId
  )
  ON CONFLICT(user_id, message_id) DO NOTHING
`);

const deleteStmt = db.prepare(`
  DELETE FROM user_bookmarks WHERE user_id = ? AND message_id = ?
`);

const existsStmt = db.prepare(`
  SELECT 1 FROM user_bookmarks WHERE user_id = ? AND message_id = ?
`);

export function addBookmark(userId: number, messageId: number): boolean {
  insertStmt.run({ userId, messageId });
  return !!existsStmt.get(userId, messageId);
}

export function removeBookmark(userId: number, messageId: number): void {
  deleteStmt.run(userId, messageId);
}

export function isBookmarked(userId: number, messageId: number): boolean {
  return !!existsStmt.get(userId, messageId);
}

// There is deliberately no "every id this user saved" accessor. That query
// existed to seed a connect-burst snapshot, which grew without bound over an
// account's life; bookmark state now rides on the message rows (`bookmarked` in
// db/messages.ts), so nothing needs to ask for the whole set at once.

// Paginated list joined with messages + networks. Row shape matches
// listUserHighlights so the same HistoryMessageRow component can render
// bookmark items unchanged.
export function listBookmarksForUser(
  userId: number,
  { before, limit = 50 }: { before?: number; limit?: number } = {},
): BookmarkEvent[] {
  const sql = before
    ? `SELECT m.*, n.name AS network_name
       FROM user_bookmarks b
       JOIN messages m ON m.id = b.message_id
       JOIN networks n ON n.id = m.network_id
       WHERE b.user_id = ?
         AND m.id < ?
       ORDER BY m.id DESC
       LIMIT ?`
    : `SELECT m.*, n.name AS network_name
       FROM user_bookmarks b
       JOIN messages m ON m.id = b.message_id
       JOIN networks n ON n.id = m.network_id
       WHERE b.user_id = ?
       ORDER BY m.id DESC
       LIMIT ?`;
  const params = before ? [userId, before, limit] : [userId, limit];
  const rows = db.prepare(sql).all(...params) as BookmarkRow[];
  return rows.map((row) => {
    const event: BookmarkEvent = {
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
      // A reply to the user is a highlight too — see HIGHLIGHTED_SQL.
      matched: row.matched_rule_id != null || row.reply_to_self === 1,
      matchedRuleId: row.matched_rule_id,
      networkName: row.network_name,
    };
    if (row.extra) {
      try {
        Object.assign(event, JSON.parse(row.extra));
      } catch (_) {
        /* ignore */
      }
    }
    // After the extra spread, as rowToEvent does: only the column may set it.
    delete event.replyToSelf;
    if (row.reply_to_self === 1) event.replyToSelf = true;
    return event;
  });
}
