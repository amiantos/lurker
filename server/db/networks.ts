// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { encryptSecret, decryptSecret } from '../utils/secretCrypto.js';
import { ENCRYPTED_NETWORK_COLUMNS } from './exportSchema.js';

// The list of encrypted network-secret columns lives in db/exportSchema.ts (a
// db-singleton-free module) so the worker-safe export builder can import it
// without pulling this module's db connection into a worker. Used below by the
// read-decrypt and write-encrypt chokepoints.

// Decrypt the secret columns on a freshly-read row, in place. No-op for legacy
// plaintext and when no key is configured (decryptSecret passes those through).
function decryptRow<T extends Network | undefined>(row: T): T {
  if (!row) return row;
  const r = row as unknown as Record<string, string | null>;
  for (const col of ENCRYPTED_NETWORK_COLUMNS) r[col] = decryptSecret(r[col]);
  return row;
}

/** A row from the `networks` table. */
export interface Network {
  id: number;
  user_id: number;
  name: string;
  host: string;
  port: number;
  tls: number;
  trusted_certificates: number;
  nick: string;
  username: string | null;
  realname: string | null;
  server_password: string | null;
  autoconnect: number;
  sasl_account: string | null;
  sasl_password: string | null;
  connect_commands: string | null;
  position: number;
  created_at: string;
}

/** A row from the `channels` table. */
export interface Channel {
  id: number;
  network_id: number;
  name: string;
  joined: number;
  created_at: string;
  // The +k channel key (decrypted on read), or null for a keyless channel.
  key: string | null;
}

/** Fields accepted when creating or updating a network. */
export interface NetworkFields {
  name?: string;
  host?: string;
  port?: number;
  tls?: boolean | number;
  trusted_certificates?: boolean | number;
  nick?: string;
  username?: string | null;
  realname?: string | null;
  server_password?: string | null;
  autoconnect?: boolean | number;
  sasl_account?: string | null;
  sasl_password?: string | null;
  connect_commands?: string | null;
}

export function listNetworksForUser(userId: number): Network[] {
  return (
    db
      .prepare('SELECT * FROM networks WHERE user_id = ? ORDER BY position ASC, id ASC')
      .all(userId) as Network[]
  ).map((row) => decryptRow(row));
}

export function getNetwork(id: number | bigint, userId: number): Network | undefined {
  return decryptRow(
    db.prepare('SELECT * FROM networks WHERE id = ? AND user_id = ?').get(id, userId) as
      | Network
      | undefined,
  );
}

const ownsNetworkStmt = db.prepare('SELECT 1 FROM networks WHERE id = ? AND user_id = ? LIMIT 1');
export function ownsNetwork(userId: number, networkId: number): boolean {
  if (!userId || !networkId) return false;
  return !!ownsNetworkStmt.get(networkId, userId);
}

export function createNetwork(userId: number, fields: NetworkFields): Network | undefined {
  const {
    name,
    host,
    port,
    tls,
    trusted_certificates,
    nick,
    username,
    realname,
    server_password,
    autoconnect,
    sasl_account,
    sasl_password,
    connect_commands,
  } = fields;
  const { next } = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM networks WHERE user_id = ?')
    .get(userId) as { next: number };
  const result = db
    .prepare(
      `
    INSERT INTO networks (user_id, name, host, port, tls, trusted_certificates, nick, username, realname, server_password, autoconnect, sasl_account, sasl_password, connect_commands, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      userId,
      name,
      host,
      port ?? 6697,
      tls ? 1 : 0,
      trusted_certificates === undefined ? 1 : trusted_certificates ? 1 : 0,
      nick,
      username || null,
      realname || null,
      encryptSecret(server_password || null),
      autoconnect === false ? 0 : 1,
      encryptSecret(sasl_account || null),
      encryptSecret(sasl_password || null),
      encryptSecret(connect_commands || null),
      next,
    );
  return getNetwork(result.lastInsertRowid, userId);
}

export function updateNetwork(
  id: number,
  userId: number,
  fields: NetworkFields,
): Network | undefined {
  const allowed: (keyof NetworkFields)[] = [
    'name',
    'host',
    'port',
    'tls',
    'trusted_certificates',
    'nick',
    'username',
    'realname',
    'server_password',
    'autoconnect',
    'sasl_account',
    'sasl_password',
    'connect_commands',
  ];
  const setClauses: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (key in fields) {
      setClauses.push(`${key} = ?`);
      let value: unknown = fields[key];
      if (key === 'tls' || key === 'autoconnect' || key === 'trusted_certificates')
        value = value ? 1 : 0;
      else if (ENCRYPTED_NETWORK_COLUMNS.includes(key)) {
        value = encryptSecret(value as string | null);
      }
      params.push(value);
    }
  }
  if (!setClauses.length) return getNetwork(id, userId);
  params.push(id, userId);
  db.prepare(`UPDATE networks SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`).run(
    ...params,
  );
  return getNetwork(id, userId);
}

export function deleteNetwork(id: number, userId: number): void {
  db.prepare('DELETE FROM networks WHERE id = ? AND user_id = ?').run(id, userId);
}

// The at-rest backfill that wraps any plaintext secret columns once a key is
// configured (networks, channels, and the e2e keyring) is now schema-driven and
// lives in db/secretBackfill.ts (backfillEncryptColumns), replacing the
// per-table siblings that used to live here.

// Rewrite the sidebar order for one user. The caller must supply exactly the
// user's current set of network ids (no adds, no drops); the function returns
// null on mismatch so the caller can echo authoritative state back. On success
// returns the new ordered id list. Mirrors reorderPins().
export function reorderNetworks(userId: number, ids: unknown[]): number[] | null {
  if (!userId || !Array.isArray(ids)) return null;
  const current = (
    db.prepare('SELECT id FROM networks WHERE user_id = ?').all(userId) as Array<{ id: number }>
  ).map((r) => r.id);
  const currentSet = new Set(current);
  if (ids.length !== currentSet.size) return null;
  const numericIds: number[] = [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || !currentSet.has(id)) return null;
    numericIds.push(id);
  }
  const setPos = db.prepare('UPDATE networks SET position = ? WHERE id = ? AND user_id = ?');
  const tx = db.transaction(() => {
    let i = 0;
    for (const id of numericIds) {
      setPos.run(i, id, userId);
      i += 1;
    }
  });
  tx();
  return [...numericIds];
}

// Decrypt the channel key in place. No-op for legacy plaintext / no key.
function decryptChannel<T extends Channel | undefined>(row: T): T {
  if (row) row.key = decryptSecret(row.key);
  return row;
}

export function listChannels(networkId: number): Channel[] {
  return (
    db
      .prepare('SELECT * FROM channels WHERE network_id = ? ORDER BY name')
      .all(networkId) as Channel[]
  ).map((row) => decryptChannel(row)!);
}

export function upsertChannel(
  networkId: number,
  name: string,
  joined: boolean | number,
  key?: string | null,
): Channel | undefined {
  // key === undefined means "don't touch the stored key" — most callers (NAMES,
  // reopen, part/kick) don't know it and must not clobber a key set at join.
  // A provided value (string or null) is written, so an explicit null clears it.
  if (key === undefined) {
    db.prepare(
      `
      INSERT INTO channels (network_id, name, joined) VALUES (?, ?, ?)
      ON CONFLICT (network_id, name) DO UPDATE SET joined = excluded.joined
    `,
    ).run(networkId, name, joined ? 1 : 0);
  } else {
    db.prepare(
      `
      INSERT INTO channels (network_id, name, joined, key) VALUES (?, ?, ?, ?)
      ON CONFLICT (network_id, name) DO UPDATE SET joined = excluded.joined, key = excluded.key
    `,
    ).run(networkId, name, joined ? 1 : 0, encryptSecret(key));
  }
  return decryptChannel(
    db.prepare('SELECT * FROM channels WHERE network_id = ? AND name = ?').get(networkId, name) as
      | Channel
      | undefined,
  );
}

// Update just the stored +k key for a channel (from a live MODE +k/-k), matched
// case-insensitively since the MODE target case may differ from the joined name.
// `null` clears it (on -k). No-op if the channel row doesn't exist.
export function setChannelKey(networkId: number, name: string, key: string | null): void {
  db.prepare('UPDATE channels SET key = ? WHERE network_id = ? AND name = ? COLLATE NOCASE').run(
    encryptSecret(key),
    networkId,
    name,
  );
}

export function deleteChannel(networkId: number, name: string): void {
  // Folded, not case-exact: IRC channel names are case-insensitive, and the
  // name we're asked to delete by often comes from the server (a 470 forward
  // relays whatever case it likes) while the stored row carries the case the
  // user typed at join. An exact match silently leaves the row behind — and a
  // surviving channels row is what auto-rejoins on every reconnect. Folding
  // also sweeps up any duplicate-cased rows for the same channel.
  db.prepare('DELETE FROM channels WHERE network_id = ? AND lower(name) = lower(?)').run(
    networkId,
    name,
  );
}
