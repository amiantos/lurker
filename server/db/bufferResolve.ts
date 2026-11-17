// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { foldTargetFor, ensureServerBuffer, ensureExists, kindForTarget } from './buffers.js';
import type { BufferKind, BufferState } from './buffers.js';

// Name → buffer_id resolution, in one place.
//
// A buffer's identity is buffers.id; its name is an attribute resolved through
// here. Resolution is deliberately UNCACHED: it is one idx_buffers_key point
// seek — the same cost the hot paths already pay for getState — and a name→id
// cache would be a second place storing the name, which is the exact bug class
// the normalization exists to kill. If profiling ever demands one, its
// invalidation belongs to renameBuffer/deleteBuffer alone.
//
// Folding happens on the way in, through `foldTargetFor` (buffers.ts) — the
// network's declared ISUPPORT CASEMAPPING since #707, legacy Unicode-lowercase
// until a network declares one. Getting the fold wrong through this seam fails
// to FIND a buffer — visible and recoverable — rather than splitting one,
// which is the property that made deferring #707 safe while the seam waited.

export { foldTargetFor } from './buffers.js';

/** Decrypt-free buffer identity row — no +k key material (a rotated secret
 *  must not make resolution throw; see buffers.ts getState). */
export interface BufferIdentity {
  id: number;
  userId: number;
  networkId: number | null;
  target: string;
  targetFolded: string;
  kind: BufferKind;
  state: BufferState;
}

interface IdentityRow {
  id: number;
  user_id: number;
  network_id: number | null;
  target: string;
  target_folded: string;
  kind: BufferKind;
  state: BufferState;
}

const IDENTITY_COLS = `id, user_id, network_id, target, target_folded, kind, state`;

function toIdentity(row: IdentityRow | undefined): BufferIdentity | undefined {
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    networkId: row.network_id,
    target: row.target,
    targetFolded: row.target_folded,
    kind: row.kind,
    state: row.state,
  };
}

const byUserStmt = db.prepare(`
  SELECT ${IDENTITY_COLS} FROM buffers
  WHERE user_id = ? AND IFNULL(network_id, 0) = IFNULL(?, 0) AND target_folded = ?
`);

// Network-scoped variant for the messages layer, which has no userId in hand:
// messages carry no user_id (ownership is network → user), so the owner is
// derived the same way BOOKMARKED_COL derives it.
const byNetworkStmt = db.prepare(`
  SELECT ${IDENTITY_COLS} FROM buffers
  WHERE user_id = (SELECT user_id FROM networks WHERE id = ?)
    AND IFNULL(network_id, 0) = ?
    AND target_folded = ?
`);

// Not a row a merge is still draining (#1307, bufferMergeDrain.ts): to a
// client that id is the absorbed buffer, which the merge told it is gone.
const byIdStmt = db.prepare(
  `SELECT ${IDENTITY_COLS} FROM buffers WHERE id = ? AND merged_into IS NULL`,
);

/** Resolve (user, network, name) → identity, or undefined when no row exists. */
export function resolveBuffer(
  userId: number,
  networkId: number | null,
  target: string,
): BufferIdentity | undefined {
  return toIdentity(
    byUserStmt.get(userId, networkId, foldTargetFor(networkId, target)) as IdentityRow | undefined,
  );
}

/** Resolve (network, name) → buffer id for network-owned rows (messages). */
export function resolveBufferIdByNetwork(networkId: number, target: string): number | undefined {
  return (
    byNetworkStmt.get(networkId, networkId, foldTargetFor(networkId, target)) as
      | IdentityRow
      | undefined
  )?.id;
}

const drainingIntoStmt = db.prepare(
  `SELECT id FROM buffers WHERE merged_into = ? ORDER BY id DESC`,
);

/** The ids of rows a merge is still draining into `bufferId` (#1307,
 *  bufferMergeDrain.ts): empty but for the seconds after a large merge, and
 *  one probe of a partial index that is nearly always empty. Their messages
 *  are this buffer's older history that has not arrived. */
export function drainingInto(bufferId: number): number[] {
  return (drainingIntoStmt.all(bufferId) as Array<{ id: number }>).map((r) => r.id);
}

/**
 * Look a line up in `bufferId`, and where it is not found, in the history
 * still draining into it. For the lookups a WRITE hangs on (the line a REDACT,
 * a reaction or a reply names): a miss there is acted on for good, where a
 * short page is only short until the drain is done. The survivor is tried
 * first: it holds the newer rows, and the newest copy of a msgid wins.
 */
export function findAcrossDrain<T>(
  bufferId: number,
  find: (id: number) => T | null | undefined,
): T | null {
  const found = find(bufferId);
  if (found != null) return found;
  for (const id of drainingInto(bufferId)) {
    const older = find(id);
    if (older != null) return older;
  }
  return null;
}

/** Identity by primary key — the wire-facing lookup for frames carrying
 *  bufferId. */
export function getBufferById(id: number): BufferIdentity | undefined {
  return toIdentity(byIdStmt.get(id) as IdentityRow | undefined);
}

/** getBufferById gated on ownership — the verb-layer guard: a client-supplied
 *  bufferId that doesn't belong to the user resolves to nothing, same as an
 *  unknown name. */
export function requireBufferForUser(userId: number, id: number): BufferIdentity | undefined {
  const found = getBufferById(id);
  return found && found.userId === userId ? found : undefined;
}

const networkOwnerStmt = db.prepare(`SELECT user_id FROM networks WHERE id = ?`);

/**
 * Insert-path resolution with a mint for targets that have no row yet.
 *
 * This is the SAME rule wsHub's live filter has applied since the registry
 * landed — "a persisted event for a target with no registry row mints one"
 * (ensureExists: creates OPEN, never reopens a closed row) — moved from a
 * moment after the insert to the insert itself, because the id-keyed table
 * cannot represent "row exists, buffer doesn't" the way name-keyed reads
 * tolerated. The distinction that matters is preserved exactly: a target with
 * an existing CLOSED row resolves to it without touching its state, so the
 * filter's reopen gate (which events outrank a user's closed flag) still
 * decides whether the buffer resurfaces.
 *
 * Sentinels route to their open mint; a stray ':'-prefixed non-sentinel
 * target (an imported ':server:<foreignId>' string) is minted 'server'-kinded
 * so kindForTarget's channel/dm split never claims it.
 *
 * A DM whose first line is from an ignored sender (`fromIgnored`) is minted
 * closed, so the filter's closed-row gate drops it the way it drops their line
 * to a DM the user closed. Otherwise anyone ignored could
 * put a DM in the sidebar just by sending to a nick they hadn't before.
 */
export function resolveOrMintForInsert(
  networkId: number,
  target: string,
  fromIgnored = false,
): number | undefined {
  const found = resolveBufferIdByNetwork(networkId, target);
  if (found !== undefined) return found;
  if (target === `:server:${networkId}`) return ensureServerBuffer(networkId)?.id;
  const owner = networkOwnerStmt.get(networkId) as { user_id: number } | undefined;
  if (!owner) return undefined;
  const kind: BufferKind | undefined = target.startsWith(':') ? 'server' : undefined;
  const closed = fromIgnored && !kind && kindForTarget(target) === 'dm';
  return ensureExists(owner.user_id, networkId, target, {
    ...(kind ? { kind } : {}),
    ...(closed ? { closed } : {}),
  }).record.id;
}
