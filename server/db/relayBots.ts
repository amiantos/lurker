// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

// Per-(user, network, nick) relay-bot marks (#277). A marked nick is a relay /
// bridge bot whose messages wrap another person's speech in an envelope like
// `[Discord] <alice> hi`; the client re-attributes those lines to the embedded
// speaker. A row's presence IS the mark; `pattern` is an optional custom
// template (empty = use the built-in default formats). nick collates NOCASE so
// case-flips don't fragment, and the same nick on different networks is its own
// row because the bots may be unrelated.

/** A row from the `user_relay_bots` table. */
export interface UserRelayBot {
  user_id: number;
  network_id: number;
  nick: string;
  pattern: string;
  created_at: string;
}

/** Projected mark returned to callers. */
export interface RelayBotResult {
  nick: string;
  pattern: string;
}

const upsertStmt = db.prepare(`
  INSERT INTO user_relay_bots (user_id, network_id, nick, pattern, created_at)
  VALUES (@userId, @networkId, @nick, @pattern, datetime('now'))
  ON CONFLICT(user_id, network_id, nick) DO UPDATE SET
    pattern = excluded.pattern
`);

const deleteStmt = db.prepare(`
  DELETE FROM user_relay_bots
  WHERE user_id = @userId AND network_id = @networkId AND nick = @nick COLLATE NOCASE
`);

const getStmt = db.prepare(`
  SELECT nick, pattern FROM user_relay_bots
  WHERE user_id = ? AND network_id = ? AND nick = ? COLLATE NOCASE
`);

const listForUserStmt = db.prepare(`
  SELECT network_id AS networkId, nick, pattern
  FROM user_relay_bots
  WHERE user_id = ?
`);

/** Mark a nick as a relay bot (upsert), optionally with a custom template. */
export function setRelayBot({
  userId,
  networkId,
  nick,
  pattern,
}: {
  userId: number;
  networkId: number;
  nick: string;
  pattern: string;
}): RelayBotResult | null {
  upsertStmt.run({ userId, networkId, nick, pattern: (pattern || '').trim() });
  return (getStmt.get(userId, networkId, nick) as RelayBotResult | undefined) ?? null;
}

/** Clear a relay-bot mark. */
export function removeRelayBot({
  userId,
  networkId,
  nick,
}: {
  userId: number;
  networkId: number;
  nick: string;
}): void {
  deleteStmt.run({ userId, networkId, nick });
}

export function getRelayBot({
  userId,
  networkId,
  nick,
}: {
  userId: number;
  networkId: number;
  nick: string;
}): RelayBotResult | null {
  return (getStmt.get(userId, networkId, nick) as RelayBotResult | undefined) ?? null;
}

// Map<networkId, [{ nick, pattern }, ...]> for snapshot seeding.
export function listForUserGrouped(
  userId: number,
): Map<number, Array<{ nick: string; pattern: string }>> {
  const out = new Map<number, Array<{ nick: string; pattern: string }>>();
  for (const row of listForUserStmt.all(userId) as Array<{
    networkId: number;
    nick: string;
    pattern: string;
  }>) {
    const entry = { nick: row.nick, pattern: row.pattern };
    const list = out.get(row.networkId);
    if (list) list.push(entry);
    else out.set(row.networkId, [entry]);
  }
  return out;
}
