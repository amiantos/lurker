// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { ensureServerBuffer, invalidateCasemappingCache } from './buffers.js';
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
  /** CertFP (#459): the PEM certificate + private key this network presents on
   *  the TLS handshake, so services identify the user by its fingerprint. Always
   *  written as a pair — see setNetworkClientCert, the only writer that
   *  validates. Deliberately absent from NetworkFields: a cert is a validated
   *  pair, not a free-text field, so it can't ride a PATCH body onto the
   *  dialer. Archive import DOES write both columns verbatim (exportSchema
   *  drives its column list), which is why the dial path re-checks the pair
   *  before presenting it rather than trusting what is stored. */
  client_cert: string | null;
  client_key: string | null;
  position: number;
  /** ISUPPORT CASEMAPPING as last declared by the server (#707); null until
   *  the network first connects to one that declares it. Server-captured
   *  (stored by db/refoldBuffers inside the refold transaction), deliberately
   *  not part of NetworkFields — a PATCH body must not be able to plant a
   *  fold rule the registry wasn't rewritten under.
   *
   *  Typed `string | null`, NOT the Casemapping union, on purpose: this
   *  mirrors the raw column, which archive import writes verbatim — so an
   *  archive from a newer Lurker could legally hold a value this build
   *  doesn't know. The union lives at the read boundary
   *  (buffers.networkCasemapping normalizes, unknown → null = legacy fold)
   *  and at the sole writer (refoldNetworkBuffers takes Casemapping). */
  casemapping: string | null;
  created_at: string;
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
  // The network's `:server:` buffer is a real registry row (kind 'server',
  // schema 17) — minted with the network so its console history and read
  // pointer have an id from the first event.
  ensureServerBuffer(Number(result.lastInsertRowid));
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

/** Attach a CertFP pair to a network, or clear it (both null). The caller
 *  validates the PEMs first (utils/clientCert.validateClientCertPair) — this is
 *  storage, not a parser. Written together so a cert can never outlive the key
 *  that has to complete its handshake. */
export function setNetworkClientCert(
  id: number,
  userId: number,
  pair: { cert: string; key: string } | null,
): Network | undefined {
  db.prepare(
    'UPDATE networks SET client_cert = ?, client_key = ? WHERE id = ? AND user_id = ?',
  ).run(encryptSecret(pair ? pair.cert : null), encryptSecret(pair ? pair.key : null), id, userId);
  return getNetwork(id, userId);
}

export function deleteNetwork(id: number, userId: number): void {
  db.prepare('DELETE FROM networks WHERE id = ? AND user_id = ?').run(id, userId);
  // SQLite may hand a future network this id (rowid reuse); a cached
  // CASEMAPPING surviving the row would fold the newcomer's targets with the
  // dead network's rule.
  invalidateCasemappingCache(id);
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
