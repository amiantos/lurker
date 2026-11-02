// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { METADATA_SUB_KEYS } from '../../shared/metadataKeys.js';

// Our own IRCv3 metadata on each network (#1189): what we last set, kept
// because most servers forget it at disconnect. A null value is a saved
// unset — the key is cleared on the server at the next connect too.

/** A row from the `network_metadata` table. */
export interface NetworkMetadataRow {
  network_id: number;
  user_id: number;
  key: string;
  value: string | null;
  updated_at: string;
}

const listStmt = db.prepare(`
  SELECT key, value FROM network_metadata WHERE network_id = ? ORDER BY key
`);

const upsertStmt = db.prepare(`
  INSERT INTO network_metadata (network_id, user_id, key, value, updated_at)
  VALUES (@networkId, @userId, @key, @value, datetime('now'))
  ON CONFLICT(network_id, key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

const clearStmt = db.prepare(`
  UPDATE network_metadata SET value = NULL, updated_at = datetime('now')
  WHERE network_id = ? AND value IS NOT NULL
`);

/** Every saved key on a network, unsets included (value null). */
export function listNetworkMetadata(networkId: number): Map<string, string | null> {
  const rows = listStmt.all(networkId) as Array<{ key: string; value: string | null }>;
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** The saved keys that have a value, for showing, and the saved unsets. */
export function networkMetadataValues(networkId: number): {
  values: Record<string, string>;
  unset: string[];
} {
  const rows = [...listNetworkMetadata(networkId)];
  // fromEntries makes own properties, a key named `__proto__` included.
  return {
    values: Object.fromEntries(rows.filter((row): row is [string, string] => row[1] !== null)),
    unset: rows.filter(([, value]) => value === null).map(([key]) => key),
  };
}

/** Save one key: a value, or null to keep it unset. */
export function saveNetworkMetadata(
  userId: number,
  networkId: number,
  key: string,
  value: string | null,
): void {
  upsertStmt.run({ networkId, userId, key, value });
}

/** Several keys at once, as one write. */
export const saveNetworkMetadataMany = db.transaction(
  (userId: number, networkId: number, values: Map<string, string | null>): void => {
    for (const [key, value] of values) upsertStmt.run({ networkId, userId, key, value });
  },
);

/**
 * `METADATA * CLEAR`: every saved key becomes a saved unset, and so does every
 * key Lurker shows — a server that kept one Lurker never saved (set from
 * another client) has it cleared at the next connect too.
 *
 * `asOf` is the saved rows as they were when the CLEAR was TYPED, for a save
 * that happens when the line goes (#1259): a key saved since — the profile
 * editor, while the CLEAR waited its turn behind a backlog — is newer than the
 * CLEAR and keeps its value, as it does on the server, where the re-set that
 * save queued follows the CLEAR out. Without it, every key goes.
 */
export const clearNetworkMetadata = db.transaction(
  (userId: number, networkId: number, asOf?: Map<string, string | null>): void => {
    if (!asOf) {
      clearStmt.run(networkId);
      for (const key of METADATA_SUB_KEYS) upsertStmt.run({ networkId, userId, key, value: null });
      return;
    }
    const now = listNetworkMetadata(networkId);
    for (const key of new Set([...now.keys(), ...METADATA_SUB_KEYS])) {
      if ((now.get(key) ?? null) !== (asOf.get(key) ?? null)) continue;
      upsertStmt.run({ networkId, userId, key, value: null });
    }
  },
);
