// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { encryptSecret, decryptSecret } from '../utils/secretCrypto.js';
import { foldTargetWith, normalizeCasemapping } from './casemapping.js';
import { isChannelTarget } from '../../shared/channels.js';
import type { Casemapping } from './casemapping.js';

// The buffer registry — the single owner of "does this buffer exist" and "is it
// in the sidebar". A buffer exists because a row exists here, not because
// messages exist (the retired derived model), and closing is a state flip, not
// a row in a side table (the retired closed_buffers). Channel-only columns
// (autojoin, key) ride along nullable; live membership stays in the in-memory
// IrcConnection.channels Map and is never persisted as truth.
//
// Casing: `target` keeps the canonical display casing (first writer wins; the
// live paths fold forward to it). `target_folded` is the ONLY lookup key, so a
// server relaying `#Chan` for a buffer stored as `#chan` can neither fork a
// second row nor slip past a closed check (#268/#289/#327). The folding rule
// is per-network since #707 — the server-declared ISUPPORT CASEMAPPING, via
// `foldTargetFor` — with the legacy Unicode-lowercase fold for undeclared
// networks and the system buffer. Stored folds are rewritten (and collisions
// merged) by db/refoldBuffers when a network's declared mapping changes.
//
// Write discipline (the whole reducer):
//   - join ECHO            → ensureOpen(autojoin: true, key) — the only
//                            row-creating path for channels
//   - message/action       → ensureOpen() — creates DM rows, reopens closed ones
//   - NOTICE               → ensureExists() — may create, NEVER reopens
//   - close                → close() — update-only; closing what doesn't exist
//                            is a no-op (never conjures a row)
//   - part/kick/470/442    → setAutojoin(false) — row and history persist
//   - MODE +k/-k           → setChannelKey()

export type BufferKind = 'channel' | 'dm' | 'server' | 'system';
export type BufferState = 'open' | 'closed';

export interface BufferRecord {
  id: number;
  userId: number;
  networkId: number | null;
  target: string;
  kind: BufferKind;
  state: BufferState;
  autojoin: boolean;
  /** Decrypted channel +k key, null when keyless. */
  key: string | null;
  createdAt: string;
  closedAt: string | null;
}

/** The LEGACY folding rule — Unicode lowercase, what every pre-#707 row's
 *  target_folded was built with. Still the rule for the system buffer (no
 *  network to declare a mapping) and for any network that hasn't declared
 *  one. Everything network-scoped should fold through `foldTargetFor`. */
export function foldTarget(target: string): string {
  return target.toLowerCase();
}

const casemappingStmt = db.prepare(`SELECT casemapping FROM networks WHERE id = ?`);

// networkId → declared mapping, lazily filled. Cached — unlike name→id
// resolution, which stays uncached on principle — because the invalidation
// story is the opposite of a name's: exactly two writers exist (the refold
// pass that stores a newly-declared mapping, and network deletion, whose ids
// SQLite may reuse), both call invalidateCasemappingCache below, and the
// value is read on every buffer-keyed lookup — several times per inbound
// message — where an uncached PK seek would double the statement count of
// the whole hot path for a value that changes at most once per network life.
const casemappingCache = new Map<number, Casemapping | null>();

/** Drop a network's cached CASEMAPPING — or, with no argument, all of them.
 *  Callers are the paths that can make an entry lie: the refold pass (after
 *  its transaction stores a new mapping), network deletion (SQLite can reuse
 *  the id for a future network), and an import ROLLBACK (whole-cache clear:
 *  the buffers import folds through the cache mid-transaction, and a
 *  rollback reverts sqlite_sequence, so the rolled-back ids — cached with
 *  the rolled-back mappings — are exactly the ids the retry will mint). */
export function invalidateCasemappingCache(networkId?: number): void {
  if (networkId === undefined) casemappingCache.clear();
  else casemappingCache.delete(networkId);
}

/** The network's declared ISUPPORT CASEMAPPING, as last captured on connect
 *  (#707) — null until the network first declares one. */
export function networkCasemapping(networkId: number): Casemapping | null {
  const cached = casemappingCache.get(networkId);
  if (cached !== undefined) return cached;
  const raw = (casemappingStmt.get(networkId) as { casemapping: string | null } | undefined)
    ?.casemapping;
  const mapping = normalizeCasemapping(raw) ?? null;
  casemappingCache.set(networkId, mapping);
  return mapping;
}

/** Per-network target folding (#707): the server-declared CASEMAPPING rule,
 *  falling back to the legacy fold until the network declares one. */
export function foldTargetFor(networkId: number | null, raw: string): string {
  if (networkId == null) return foldTarget(raw);
  return foldTargetWith(networkCasemapping(networkId), raw);
}

/** channel/dm classification by target shape (server/system rows are minted
 *  explicitly by their owners, never inferred). */
export function kindForTarget(target: string): BufferKind {
  return isChannelTarget(target) ? 'channel' : 'dm';
}

interface BufferRow {
  id: number;
  user_id: number;
  network_id: number | null;
  target: string;
  kind: BufferKind;
  state: BufferState;
  autojoin: number;
  key: string | null;
  created_at: string;
  closed_at: string | null;
}

function toRecord(row: BufferRow): BufferRecord;
function toRecord(row: BufferRow | undefined): BufferRecord | undefined;
function toRecord(row: BufferRow | undefined): BufferRecord | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    networkId: row.network_id,
    target: row.target,
    kind: row.kind,
    state: row.state,
    autojoin: !!row.autojoin,
    key: decryptSecret(row.key),
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

// IFNULL on both sides so a NULL network_id (app-scoped) row matches itself;
// identity for real network ids. Same pattern as buffer_reads.
const getStmt = db.prepare(`
  SELECT * FROM buffers
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
`);

const insertStmt = db.prepare(`
  INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state, autojoin, key)
  VALUES (@userId, @networkId, @target, @targetFolded, @kind, @state, @autojoin, @key)
`);

const reopenStmt = db.prepare(`
  UPDATE buffers SET state = 'open', closed_at = NULL
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
    AND state = 'closed'
`);

// server/system rows are permanent fixtures (the server console and the app
// console always exist); the kind guard makes closing one structurally
// impossible rather than a code-path promise.
const closeStmt = db.prepare(`
  UPDATE buffers SET state = 'closed', closed_at = datetime('now')
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
    AND state = 'open' AND kind NOT IN ('server', 'system')
`);

const setAutojoinStmt = db.prepare(`
  UPDATE buffers SET autojoin = ?
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
`);

const setKeyStmt = db.prepare(`
  UPDATE buffers SET key = ?
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
`);

// Same kind guard as closeStmt — and doubly load-bearing now that satellite
// rows cascade from buffers(id): deleting a sentinel row would take its read
// pointer (and, post-v17, its messages) with it.
const deleteStmt = db.prepare(`
  DELETE FROM buffers
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
    AND kind NOT IN ('server', 'system')
`);

// Import-path only: close (or stamp) with an archive-supplied closed_at rather
// than datetime('now').
const setClosedAtStmt = db.prepare(`
  UPDATE buffers SET state = 'closed', closed_at = ?
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
`);

const listForUserStmt = db.prepare(`
  SELECT * FROM buffers WHERE user_id = ? ORDER BY network_id, target_folded
`);

const listForNetworkStmt = db.prepare(`
  SELECT * FROM buffers WHERE network_id = ? ORDER BY target_folded
`);

const listChannelBuffersStmt = db.prepare(`
  SELECT * FROM buffers
  WHERE network_id = ? AND kind = 'channel'
  ORDER BY target_folded
`);

const listAutojoinStmt = db.prepare(`
  SELECT * FROM buffers
  WHERE network_id = ? AND kind = 'channel' AND autojoin = 1
  ORDER BY target_folded
`);

const listOpenDmsStmt = db.prepare(`
  SELECT * FROM buffers
  WHERE network_id = ? AND kind = 'dm' AND state = 'open'
  ORDER BY target_folded
`);

/** Folded point lookup. Materializes the full record (including key
 *  decryption) — hot paths that only need existence/state use getState. */
export function getBuffer(
  userId: number,
  networkId: number | null,
  target: string,
): BufferRecord | undefined {
  return toRecord(
    getStmt.get(userId, networkId, foldTargetFor(networkId, target)) as BufferRow | undefined,
  );
}

// Decrypt-free projections for the hot paths. The live event filter runs one
// of these per persisted IRC event and the snapshot walk per buffer; going
// through getBuffer there would AES-decrypt every keyed channel's +k envelope
// just to read `state` — and a key stored under a rotated/unknown key-id
// would make decryptSecret THROW inside message fanout instead of on the one
// join path that actually needs the key.
const stateStmt = db.prepare(`
  SELECT state FROM buffers
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
`);

const listStatesForUserStmt = db.prepare(`
  SELECT id, network_id, target, target_folded, state FROM buffers
  WHERE user_id = ? ORDER BY network_id, target_folded
`);

const closedFoldedForNetworkStmt = db.prepare(`
  SELECT target_folded FROM buffers WHERE network_id = ? AND state = 'closed'
`);

const autojoinFlagStmt = db.prepare(`
  SELECT autojoin FROM buffers
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
`);

/** Folded state lookup without materializing the record: 'open', 'closed', or
 *  undefined when no row exists. */
export function getState(
  userId: number,
  networkId: number | null,
  target: string,
): BufferState | undefined {
  return (
    stateStmt.get(userId, networkId, foldTargetFor(networkId, target)) as
      | { state: BufferState }
      | undefined
  )?.state;
}

/** One sidebar-shaped row per buffer (no key, no decryption) — the walk's fuel. */
export interface BufferStateRow {
  id: number;
  networkId: number | null;
  target: string;
  targetFolded: string;
  state: BufferState;
}

export function listStatesForUser(userId: number): BufferStateRow[] {
  return (
    listStatesForUserStmt.all(userId) as Array<{
      id: number;
      network_id: number | null;
      target: string;
      target_folded: string;
      state: BufferState;
    }>
  ).map((r) => ({
    id: r.id,
    networkId: r.network_id,
    target: r.target,
    targetFolded: r.target_folded,
    state: r.state,
  }));
}

/** Folded targets of a network's closed buffers — one definition of "closed"
 *  shared by the bouncer's playback burst and CHATHISTORY TARGETS. */
export function closedFoldedSetForNetwork(networkId: number): Set<string> {
  const set = new Set<string>();
  for (const r of closedFoldedForNetworkStmt.all(networkId) as Array<{ target_folded: string }>) {
    set.add(r.target_folded);
  }
  return set;
}

/** Folded closed check — replaces closed_buffers.isClosed, which was case-exact
 *  and could disagree with the folded snapshot filter about the same buffer. */
export function isClosed(userId: number, networkId: number | null, target: string): boolean {
  return getState(userId, networkId, target) === 'closed';
}

/** Folded autojoin check (#868), decrypt-free for the same reason as getState: a
 *  channel whose stored +k key was written under a since-rotated key-id would
 *  make getBuffer's decryptSecret THROW, and this runs inside the IRC error
 *  handler. False for a row that doesn't exist. */
export function isAutojoin(userId: number, networkId: number | null, target: string): boolean {
  const row = autojoinFlagStmt.get(userId, networkId, foldTargetFor(networkId, target)) as
    | { autojoin: number }
    | undefined;
  return !!row?.autojoin;
}

export interface EnsureResult {
  record: BufferRecord;
  /** A row was created (the buffer didn't exist before this call). */
  created: boolean;
  /** An existing closed row was flipped open by this call. */
  reopened: boolean;
}

// --- Sentinel buffers -------------------------------------------------------
//
// `:server:<netId>` and `:system:` are real rows as of schema 17 (kinds
// 'server'/'system', reserved since the registry landed). They are minted at
// network/user creation, by the v17 migration for existing data, and
// defensively below — never by the channel/dm reducer paths, whose
// kindForTarget would misclassify a ':'-prefixed name as a DM.

const networkOwnerStmt = db.prepare(`SELECT user_id FROM networks WHERE id = ?`);

const sentinelInsertStmt = db.prepare(`
  INSERT INTO buffers (user_id, network_id, target, target_folded, kind, state, autojoin, key)
  VALUES (?, ?, ?, ?, ?, 'open', 0, NULL)
  ON CONFLICT(user_id, IFNULL(network_id, 0), target_folded) DO NOTHING
`);

/** Make the network's `:server:` row exist; returns it. Undefined only for an
 *  unknown networkId. */
export function ensureServerBuffer(networkId: number): BufferRecord | undefined {
  const owner = networkOwnerStmt.get(networkId) as { user_id: number } | undefined;
  if (!owner) return undefined;
  const target = `:server:${networkId}`;
  sentinelInsertStmt.run(owner.user_id, networkId, target, target, 'server');
  return toRecord(getStmt.get(owner.user_id, networkId, target) as BufferRow | undefined);
}

/** Make the user's app-scoped `:system:` row exist; returns it. */
export function ensureSystemBuffer(userId: number): BufferRecord {
  sentinelInsertStmt.run(userId, null, ':system:', ':system:', 'system');
  return toRecord(getStmt.get(userId, null, ':system:') as BufferRow);
}

/** Route a ':'-prefixed target to its sentinel mint. Returns undefined for
 *  non-sentinel targets (the ordinary reducer path applies). */
function ensureSentinel(
  userId: number,
  networkId: number | null,
  target: string,
): EnsureResult | undefined {
  if (!target.startsWith(':')) return undefined;
  const record =
    target === ':system:' || networkId == null
      ? ensureSystemBuffer(userId)
      : ensureServerBuffer(networkId);
  if (!record) {
    // Unknown network for a ':server:' target — surface it as a programming
    // error; nothing legitimate constructs this.
    throw new Error(`ensureSentinel: no network ${networkId} for target ${target}`);
  }
  return { record, created: false, reopened: false };
}

/** The reducer workhorse: make (user, network, target) exist and be open.
 *  Creates the row when absent (canonical casing = the caller's casing),
 *  reopens it when closed. `autojoin` set only when passed (the join echo
 *  passes true; part/kick lower it via setAutojoin). `key` follows the
 *  upsertChannel convention: undefined = don't touch, null = clear. An
 *  existing row's target casing is never rewritten — live paths fold forward
 *  to it, matching the pre-registry behavior. */
export const ensureOpen = db.transaction(
  (
    userId: number,
    networkId: number | null,
    target: string,
    opts: { kind?: BufferKind; autojoin?: boolean; key?: string | null } = {},
  ): EnsureResult => {
    const sentinel = ensureSentinel(userId, networkId, target);
    if (sentinel) return sentinel;
    const folded = foldTargetFor(networkId, target);
    const existing = getStmt.get(userId, networkId, folded) as BufferRow | undefined;
    if (!existing) {
      insertStmt.run({
        userId,
        networkId,
        target,
        targetFolded: folded,
        kind: opts.kind ?? kindForTarget(target),
        state: 'open',
        autojoin: opts.autojoin ? 1 : 0,
        key: opts.key === undefined ? null : encryptSecret(opts.key),
      });
      return {
        record: toRecord(getStmt.get(userId, networkId, folded) as BufferRow),
        created: true,
        reopened: false,
      };
    }
    const reopened = existing.state === 'closed';
    if (reopened) reopenStmt.run(userId, networkId, folded);
    if (opts.autojoin !== undefined && !!existing.autojoin !== opts.autojoin) {
      setAutojoinStmt.run(opts.autojoin ? 1 : 0, userId, networkId, folded);
    }
    if (opts.key !== undefined) {
      setKeyStmt.run(encryptSecret(opts.key), userId, networkId, folded);
    }
    return {
      record: toRecord(getStmt.get(userId, networkId, folded) as BufferRow),
      created: false,
      reopened,
    };
  },
);

/** Insert-if-absent that NEVER reopens — the NOTICE path. A notice may mint a
 *  buffer for a first-contact nick (same as the old derived-existence model)
 *  but must not resurrect one the user closed. */
export const ensureExists = db.transaction(
  (
    userId: number,
    networkId: number | null,
    target: string,
    opts: { kind?: BufferKind } = {},
  ): { record: BufferRecord; created: boolean } => {
    const sentinel = ensureSentinel(userId, networkId, target);
    if (sentinel) return { record: sentinel.record, created: sentinel.created };
    const folded = foldTargetFor(networkId, target);
    const existing = getStmt.get(userId, networkId, folded) as BufferRow | undefined;
    if (existing) return { record: toRecord(existing), created: false };
    insertStmt.run({
      userId,
      networkId,
      target,
      targetFolded: folded,
      kind: opts.kind ?? kindForTarget(target),
      state: 'open',
      autojoin: 0,
      key: null,
    });
    return {
      record: toRecord(getStmt.get(userId, networkId, folded) as BufferRow),
      created: true,
    };
  },
);

/** Update-only closed→open flip. Returns true if a row actually flipped —
 *  the buffer-reopened fanout keys off this, same contract as the old
 *  reopenBuffer's rows-deleted. */
export function reopen(userId: number, networkId: number | null, target: string): boolean {
  return reopenStmt.run(userId, networkId, foldTargetFor(networkId, target)).changes > 0;
}

/** Update-only open→closed flip. A no-op when the row doesn't exist — closing
 *  can never conjure a buffer (the phantom-row class the old
 *  upsertChannel-on-close path had). */
export function close(userId: number, networkId: number | null, target: string): boolean {
  return closeStmt.run(userId, networkId, foldTargetFor(networkId, target)).changes > 0;
}

/** Update-only; absent row = no-op. Lowered on part/kick/470/442 so a failed
 *  or abandoned channel never auto-rejoins; raised only by the join echo. */
export function setAutojoin(
  userId: number,
  networkId: number | null,
  target: string,
  autojoin: boolean,
): void {
  setAutojoinStmt.run(autojoin ? 1 : 0, userId, networkId, foldTargetFor(networkId, target));
}

/** Update-only; null clears (MODE -k). Encrypted at rest via secretCrypto. */
export function setChannelKey(
  userId: number,
  networkId: number | null,
  target: string,
  key: string | null,
): void {
  setKeyStmt.run(encryptSecret(key), userId, networkId, foldTargetFor(networkId, target));
}

/** Config-time channel seed (network create's default_channels): the buffer
 *  exists as an autojoin/key carrier but stays un-surfaced ('closed' with NULL
 *  closed_at — the "never surfaced" shape) until its first join echo, so a
 *  configured-but-never-joined channel doesn't appear in the sidebar as an
 *  empty parted buffer. An existing row just gains autojoin (+key). */
export const seedAutojoinChannel = db.transaction(
  (userId: number, networkId: number, target: string, key?: string | null): void => {
    const folded = foldTargetFor(networkId, target);
    const existing = getStmt.get(userId, networkId, folded) as BufferRow | undefined;
    if (!existing) {
      insertStmt.run({
        userId,
        networkId,
        target,
        targetFolded: folded,
        kind: 'channel',
        state: 'closed',
        autojoin: 1,
        key: key == null ? null : encryptSecret(key),
      });
      return;
    }
    setAutojoinStmt.run(1, userId, networkId, folded);
    if (key !== undefined) setKeyStmt.run(encryptSecret(key), userId, networkId, folded);
  },
);

/** Merge one row into the registry with the same conflict semantics as the
 *  schema-16 backfill (autojoin = MAX, key = first non-null, closed wins and
 *  carries its closed_at). The import path's primitive — `key` is plaintext
 *  from the archive and encrypted here. */
export const importRow = db.transaction(
  (row: {
    userId: number;
    networkId: number | null;
    target: string;
    kind?: BufferKind;
    state: BufferState;
    autojoin?: boolean;
    key?: string | null;
    closedAt?: string | null;
  }): void => {
    const folded = foldTargetFor(row.networkId, row.target);
    const existing = getStmt.get(row.userId, row.networkId, folded) as BufferRow | undefined;
    if (!existing) {
      insertStmt.run({
        userId: row.userId,
        networkId: row.networkId,
        target: row.target,
        targetFolded: folded,
        kind: row.kind ?? kindForTarget(row.target),
        state: row.state,
        autojoin: row.autojoin ? 1 : 0,
        key: row.key == null ? null : encryptSecret(row.key),
      });
      if (row.state === 'closed' && row.closedAt != null) {
        setClosedAtStmt.run(row.closedAt, row.userId, row.networkId, folded);
      }
      return;
    }
    if (row.autojoin && !existing.autojoin) {
      setAutojoinStmt.run(1, row.userId, row.networkId, folded);
    }
    if (row.key != null && existing.key == null) {
      setKeyStmt.run(encryptSecret(row.key), row.userId, row.networkId, folded);
    }
    // Closed wins and carries its timestamp — including onto a row that is
    // ALREADY closed with no timestamp (a "never surfaced" channels-seed row
    // that a real closed_buffers tombstone then lands on). Mirrors the
    // schema-16 migration's unconditional `closed_at = excluded.closed_at`.
    if (row.state === 'closed' && (existing.state === 'open' || row.closedAt != null)) {
      setClosedAtStmt.run(row.closedAt ?? null, row.userId, row.networkId, folded);
    }
  },
);

/** Drop the row outright — the forget path for a buffer with no history left
 *  to show. Callers with history use setAutojoin(false) instead so the buffer
 *  (and its messages) survive. */
export function deleteBuffer(userId: number, networkId: number | null, target: string): boolean {
  return deleteStmt.run(userId, networkId, foldTargetFor(networkId, target)).changes > 0;
}

export function listForUser(userId: number): BufferRecord[] {
  return (listForUserStmt.all(userId) as BufferRow[]).map((r) => toRecord(r));
}

export function listForNetwork(networkId: number): BufferRecord[] {
  return (listForNetworkStmt.all(networkId) as BufferRow[]).map((r) => toRecord(r));
}

/** Channel rows only (keys decrypted) — the network-config payload. */
export function listChannelsForNetwork(networkId: number): BufferRecord[] {
  return (listChannelBuffersStmt.all(networkId) as BufferRow[]).map((r) => toRecord(r));
}

/** The reconnect rejoin list — replaces channels.joined's single consumer. */
export function listAutojoinChannels(networkId: number): BufferRecord[] {
  return (listAutojoinStmt.all(networkId) as BufferRow[]).map((r) => toRecord(r));
}

/** Open DM rows for a network — the MONITOR/presence seed. */
export function listOpenDms(networkId: number): BufferRecord[] {
  return (listOpenDmsStmt.all(networkId) as BufferRow[]).map((r) => toRecord(r));
}
