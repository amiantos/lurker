// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import type { NickMetadataValues } from '../../shared/nickMetadata.js';

// Metadata a user set on somebody else (#1449), per (user, network, nick, key).
// A NULL value is a statement too: "don't show me theirs". Keyed like a nick
// note and for the same reason: the same nick on two networks may be two
// people, and nick collates NOCASE so a case flip doesn't split the record.

const upsertStmt = db.prepare(`
  INSERT INTO user_nick_metadata (user_id, network_id, nick, key, value, updated_at)
  VALUES (@userId, @networkId, @nick, @key, @value, datetime('now'))
  ON CONFLICT(user_id, network_id, nick, key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

const deleteStmt = db.prepare(`
  DELETE FROM user_nick_metadata
  WHERE user_id = @userId AND network_id = @networkId
    AND nick = @nick COLLATE NOCASE AND key = @key
`);

const listForNickStmt = db.prepare(`
  SELECT key, value FROM user_nick_metadata
  WHERE user_id = ? AND network_id = ? AND nick = ? COLLATE NOCASE
`);

const listForUserStmt = db.prepare(`
  SELECT network_id AS networkId, nick, key, value
  FROM user_nick_metadata
  WHERE user_id = ?
  ORDER BY network_id, nick
`);

interface NickKey {
  userId: number;
  networkId: number;
  nick: string;
}

/** Everything the user set on this nick; empty when nothing. */
export function getNickMetadata({ userId, networkId, nick }: NickKey): NickMetadataValues {
  const out: NickMetadataValues = {};
  for (const row of listForNickStmt.all(userId, networkId, nick) as Array<{
    key: string;
    value: string | null;
  }>) {
    out[row.key] = row.value;
  }
  return out;
}

/** One key: a value, or null to hide the other person's. Answers the nick's whole record. */
export function setNickMetadata(
  at: NickKey & { key: string; value: string | null },
): NickMetadataValues {
  upsertStmt.run(at);
  return getNickMetadata(at);
}

/** One key back to whatever the other person set. Answers the nick's whole record. */
export function resetNickMetadata(at: NickKey & { key: string }): NickMetadataValues {
  deleteStmt.run(at);
  return getNickMetadata(at);
}

// Map<networkId, [{ nick, values }, ...]> for snapshot seeding.
export function listNickMetadataGrouped(
  userId: number,
): Map<number, Array<{ nick: string; values: NickMetadataValues }>> {
  const out = new Map<number, Array<{ nick: string; values: NickMetadataValues }>>();
  // Rows of one nick are adjacent; NOCASE on the column makes two spellings one group.
  let last: { networkId: number; lower: string; values: NickMetadataValues } | null = null;
  for (const row of listForUserStmt.all(userId) as Array<{
    networkId: number;
    nick: string;
    key: string;
    value: string | null;
  }>) {
    const lower = row.nick.toLowerCase();
    if (!last || last.networkId !== row.networkId || last.lower !== lower) {
      const values: NickMetadataValues = {};
      last = { networkId: row.networkId, lower, values };
      const list = out.get(row.networkId);
      if (list) list.push({ nick: row.nick, values });
      else out.set(row.networkId, [{ nick: row.nick, values }]);
    }
    last.values[row.key] = row.value;
  }
  return out;
}
