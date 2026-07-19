// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { encryptSecret, decryptSecret } from '../utils/secretCrypto.js';

// The buffer registry — the single owner of "does this buffer exist" and "is it
// in the sidebar". A buffer exists because a row exists here, not because
// messages exist (the retired derived model), and closing is a state flip, not
// a row in a side table (the retired closed_buffers). Channel-only columns
// (autojoin, key) ride along nullable; live membership stays in the in-memory
// IrcConnection.channels Map and is never persisted as truth.
//
// Casing: `target` keeps the canonical display casing (first writer wins; the
// live paths fold forward to it). `target_folded` (ASCII toLowerCase, house
// rule — see #268/#289/#327) is the ONLY lookup key, so a server relaying
// `#Chan` for a buffer stored as `#chan` can neither fork a second row nor slip
// past a closed check. That single folding rule is what retires the
// exact-write/folded-read split that closed_buffers had.
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

/** The one folding rule for buffer targets (ASCII, matching the client). */
export function foldTarget(target: string): string {
  return target.toLowerCase();
}

const CHANNEL_PREFIXES = new Set(['#', '&', '+', '!']);

/** channel/dm classification by target shape (server/system rows are minted
 *  explicitly by their owners, never inferred). */
export function kindForTarget(target: string): BufferKind {
  return CHANNEL_PREFIXES.has(target[0] ?? '') ? 'channel' : 'dm';
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

const closeStmt = db.prepare(`
  UPDATE buffers SET state = 'closed', closed_at = datetime('now')
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
    AND state = 'open'
`);

const setAutojoinStmt = db.prepare(`
  UPDATE buffers SET autojoin = ?
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
`);

const setKeyStmt = db.prepare(`
  UPDATE buffers SET key = ?
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
`);

const deleteStmt = db.prepare(`
  DELETE FROM buffers
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
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
  return toRecord(getStmt.get(userId, networkId, foldTarget(target)) as BufferRow | undefined);
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
  SELECT network_id, target, target_folded, state FROM buffers
  WHERE user_id = ? ORDER BY network_id, target_folded
`);

const closedFoldedForNetworkStmt = db.prepare(`
  SELECT target_folded FROM buffers WHERE network_id = ? AND state = 'closed'
`);

/** Folded state lookup without materializing the record: 'open', 'closed', or
 *  undefined when no row exists. */
export function getState(
  userId: number,
  networkId: number | null,
  target: string,
): BufferState | undefined {
  return (
    stateStmt.get(userId, networkId, foldTarget(target)) as { state: BufferState } | undefined
  )?.state;
}

/** One sidebar-shaped row per buffer (no key, no decryption) — the walk's fuel. */
export interface BufferStateRow {
  networkId: number | null;
  target: string;
  targetFolded: string;
  state: BufferState;
}

export function listStatesForUser(userId: number): BufferStateRow[] {
  return (
    listStatesForUserStmt.all(userId) as Array<{
      network_id: number | null;
      target: string;
      target_folded: string;
      state: BufferState;
    }>
  ).map((r) => ({
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

export interface EnsureResult {
  record: BufferRecord;
  /** A row was created (the buffer didn't exist before this call). */
  created: boolean;
  /** An existing closed row was flipped open by this call. */
  reopened: boolean;
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
    const folded = foldTarget(target);
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
    const folded = foldTarget(target);
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
  return reopenStmt.run(userId, networkId, foldTarget(target)).changes > 0;
}

/** Update-only open→closed flip. A no-op when the row doesn't exist — closing
 *  can never conjure a buffer (the phantom-row class the old
 *  upsertChannel-on-close path had). */
export function close(userId: number, networkId: number | null, target: string): boolean {
  return closeStmt.run(userId, networkId, foldTarget(target)).changes > 0;
}

/** Update-only; absent row = no-op. Lowered on part/kick/470/442 so a failed
 *  or abandoned channel never auto-rejoins; raised only by the join echo. */
export function setAutojoin(
  userId: number,
  networkId: number | null,
  target: string,
  autojoin: boolean,
): void {
  setAutojoinStmt.run(autojoin ? 1 : 0, userId, networkId, foldTarget(target));
}

/** Update-only; null clears (MODE -k). Encrypted at rest via secretCrypto. */
export function setChannelKey(
  userId: number,
  networkId: number | null,
  target: string,
  key: string | null,
): void {
  setKeyStmt.run(encryptSecret(key), userId, networkId, foldTarget(target));
}

/** Config-time channel seed (network create's default_channels): the buffer
 *  exists as an autojoin/key carrier but stays un-surfaced ('closed' with NULL
 *  closed_at — the "never surfaced" shape) until its first join echo, so a
 *  configured-but-never-joined channel doesn't appear in the sidebar as an
 *  empty parted buffer. An existing row just gains autojoin (+key). */
export const seedAutojoinChannel = db.transaction(
  (userId: number, networkId: number, target: string, key?: string | null): void => {
    const folded = foldTarget(target);
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
    const folded = foldTarget(row.target);
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
  return deleteStmt.run(userId, networkId, foldTarget(target)).changes > 0;
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
