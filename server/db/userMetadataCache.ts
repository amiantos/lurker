// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import type { MetadataRecord } from '../services/ircMetadata.js';

// Other nicks' IRCv3 metadata on a network, remembered (#1246, #1269). The
// connection's `userMetadata` map is the live copy; these rows mirror it so a
// socket drop, an engine re-attach or a restart doesn't strip every departed
// peer's lines of their avatar. A record is "absent" once the nick is neither
// a member of a channel we're in, a watched DM peer, nor ourselves — the
// server tells us nothing more about them, so it is their last known profile.
//
// No row cap: the disk keeps a record as long as the nick has a line to dress.
// What goes over the wire is bounded instead (IrcConnection.snapshot).

/** A row from the `user_metadata_cache` table, decoded. */
export interface CachedUserMetadata {
  /** The nick as last seen (its case), for the probe against messages.nick. */
  nick: string;
  nickLower: string;
  record: MetadataRecord;
  /** When the nick stopped being present, or null while it is. */
  absentSince: string | null;
}

interface Row {
  nick: string;
  nick_lower: string;
  record: string;
  absent_since: string | null;
}

const listStmt = db.prepare(`
  SELECT nick, nick_lower, record, absent_since
    FROM user_metadata_cache WHERE network_id = ?
`);

// The rows a snapshot of a network with no connection shows: present, or
// absent since `cutoff` at the earliest.
const listRecentStmt = db.prepare(`
  SELECT nick, nick_lower, record, absent_since
    FROM user_metadata_cache
   WHERE network_id = ? AND (absent_since IS NULL OR absent_since >= ?)
`);

const upsertStmt = db.prepare(`
  INSERT INTO user_metadata_cache
    (network_id, user_id, nick, nick_lower, record, absent_since, updated_at)
  VALUES (@networkId, @userId, @nick, @nickLower, @record, @absentSince, datetime('now'))
  ON CONFLICT(network_id, nick_lower) DO UPDATE SET
    nick = excluded.nick,
    record = excluded.record,
    absent_since = excluded.absent_since,
    updated_at = excluded.updated_at
`);

const deleteStmt = db.prepare(`
  DELETE FROM user_metadata_cache WHERE network_id = ? AND nick_lower = ?
`);

// The lines an avatar or display name dresses — the types a client draws a
// head for. Events (joins, quits, modes) wear neither, and age out on the
// noise clock anyway. Served by idx_messages_net_nick (network, nick NOCASE).
const hasLinesStmt = db.prepare(`
  SELECT 1 FROM messages
   WHERE network_id = ? AND nick = ? COLLATE NOCASE
     AND type IN ('message', 'action', 'notice')
   LIMIT 1
`);

// Every row whose nick has no such line left, in one statement — a probe per
// row inside SQLite, none across the boundary — less the nicks the caller
// still holds present (a JSON array of lowercase nicks).
const pruneStmt = db.prepare(`
  DELETE FROM user_metadata_cache AS c
   WHERE c.network_id = ?
     AND c.nick_lower NOT IN (SELECT value FROM json_each(?))
     AND NOT EXISTS (
       SELECT 1 FROM messages m
        WHERE m.network_id = c.network_id AND m.nick = c.nick COLLATE NOCASE
          AND m.type IN ('message', 'action', 'notice')
     )
  RETURNING nick, nick_lower
`);

function decode(row: Row): CachedUserMetadata | null {
  let record: unknown;
  try {
    record = JSON.parse(row.record);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const clean: MetadataRecord = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (typeof value === 'string') clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return null;
  return {
    nick: row.nick,
    nickLower: row.nick_lower,
    record: clean,
    absentSince: row.absent_since,
  };
}

/**
 * Every cached record on a network — or, with `absentSinceAfter`, those
 * present or absent since no earlier than it. A row that won't decode is
 * skipped.
 */
export function listUserMetadataCache(
  networkId: number,
  opts: { absentSinceAfter?: string } = {},
): CachedUserMetadata[] {
  const rows =
    opts.absentSinceAfter === undefined
      ? (listStmt.all(networkId) as Row[])
      : (listRecentStmt.all(networkId, opts.absentSinceAfter) as Row[]);
  const out: CachedUserMetadata[] = [];
  for (const row of rows) {
    const decoded = decode(row);
    if (decoded) out.push(decoded);
  }
  return out;
}

/**
 * Drop the rows whose nick has no line left to dress, keeping those in
 * `presentLowers` (held live by a connection, whatever their lines). Returns
 * what went.
 */
export function pruneUserMetadataCache(
  networkId: number,
  presentLowers: string[],
): Array<{ nick: string; nickLower: string }> {
  const rows = pruneStmt.all(networkId, JSON.stringify(presentLowers)) as Array<{
    nick: string;
    nick_lower: string;
  }>;
  return rows.map((row) => ({ nick: row.nick, nickLower: row.nick_lower }));
}

/**
 * Mirror a batch of changes as one write: each entry replaces the nick's row
 * (an empty record deletes it).
 */
export const writeUserMetadataCache = db.transaction(
  (userId: number, networkId: number, entries: CachedUserMetadata[]): void => {
    for (const entry of entries) {
      if (Object.keys(entry.record).length === 0) {
        deleteStmt.run(networkId, entry.nickLower);
        continue;
      }
      upsertStmt.run({
        networkId,
        userId,
        nick: entry.nick,
        nickLower: entry.nickLower,
        record: JSON.stringify(entry.record),
        absentSince: entry.absentSince,
      });
    }
  },
);

/** Whether the nick has a line left on the network that a record would dress. */
export function nickHasChatLines(networkId: number, nick: string): boolean {
  return hasLinesStmt.get(networkId, nick) !== undefined;
}
