// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { foldTargetFor } from './buffers.js';
import { resolveBuffer } from './bufferResolve.js';
import { renumberFavorites } from './favoriteBuffers.js';

// Rename a buffer — the primitive behind DM nick-follows (and, when the
// draft/channel-rename CAP lands, channel renames). Under the normalized
// schema this is what the closed PR #706 spent 650 lines approximating with
// name-keyed rewrites: identity is buffers.id, so the plain case is ONE
// UPDATE on one row, and nothing else in the database mentions the name.
//
// THE invariant (CLIENT_PROTOCOL §5.2): a buffer's id never changes, renames
// included. A merge therefore deletes the OTHER row — the SOURCE survives.
// The source is the live conversation (the DM being renamed under the user's
// feet); destination-survives would force every client to handle "your
// active buffer's identity just changed", which is strictly harder than
// "some other buffer you may hold was absorbed".
//
// Merge policies for the absorbed row's satellite state mirror the v18
// case-twin rebuild: furthest read pointer + max clear marker, survivor's
// pin slot (or adopt the absorbed one), survivor's view-state rows win,
// survivor's draft wins when present. Messages repoint wholesale — the
// merged history interleaves by id, which is already global order.

export interface RenameResult {
  /** False when nothing happened (unknown source, or a true no-op). */
  renamed: boolean;
  /** The surviving buffer — same id the source always had. */
  bufferId: number;
  /** Canonical pre-rename name (registry casing, not the caller's). */
  from: string;
  /** The name as stored post-rename (the requested casing). */
  to: string;
  /** True when a row already existed under the new name and was absorbed. */
  merged: boolean;
  /** The absorbed row's id — clients must drop this buffer. */
  mergedFromBufferId?: number;
  /** True when the merge left the surviving draft different from the
   *  source's (the client should refresh its mirror). */
  draftChanged: boolean;
  /** Whether the surviving buffer is OPEN after the rename (union on a
   *  merge). Callers must not announce a closed survivor: clients hold no
   *  state for closed buffers, and a merged frame for one makes them
   *  materialize a sidebar row for a conversation closed everywhere. */
  open: boolean;
}

const setNameStmt = db.prepare(`UPDATE buffers SET target = ?, target_folded = ? WHERE id = ?`);
const setOpenStmt = db.prepare(`UPDATE buffers SET state = 'open', closed_at = NULL WHERE id = ?`);
const deleteRowStmt = db.prepare(`DELETE FROM buffers WHERE id = ?`);

// --- merge helpers (absorbed → survivor) -----------------------------------

const repointMessages = db.prepare(`UPDATE messages SET buffer_id = ? WHERE buffer_id = ?`);
const repointInputHistory = db.prepare(
  `UPDATE input_history SET buffer_id = ? WHERE buffer_id = ?`,
);

// buffer_reads: fold the absorbed row into the survivor's (furthest pointer,
// max marker with its own timestamp), then let the absorbed row die with its
// buffer (ON DELETE CASCADE).
const mergeReadsStmt = db.prepare(`
  UPDATE buffer_reads SET
    last_read_message_id = MAX(
      last_read_message_id,
      COALESCE((SELECT r2.last_read_message_id FROM buffer_reads r2
                 WHERE r2.user_id = buffer_reads.user_id AND r2.buffer_id = @absorbed), 0)),
    cleared_at = CASE
      WHEN COALESCE((SELECT r2.cleared_before_message_id FROM buffer_reads r2
                      WHERE r2.user_id = buffer_reads.user_id AND r2.buffer_id = @absorbed), 0)
           > COALESCE(cleared_before_message_id, 0)
      THEN (SELECT r2.cleared_at FROM buffer_reads r2
             WHERE r2.user_id = buffer_reads.user_id AND r2.buffer_id = @absorbed)
      ELSE cleared_at END,
    cleared_before_message_id = NULLIF(MAX(
      COALESCE(cleared_before_message_id, 0),
      COALESCE((SELECT r2.cleared_before_message_id FROM buffer_reads r2
                 WHERE r2.user_id = buffer_reads.user_id AND r2.buffer_id = @absorbed), 0)), 0)
  WHERE buffer_id = @survivor
`);
const adoptReadsStmt = db.prepare(
  `UPDATE OR IGNORE buffer_reads SET buffer_id = ? WHERE buffer_id = ?`,
);

// pins: survivor keeps its slot; an absorbed-only pin transfers.
const adoptPinStmt = db.prepare(
  `UPDATE OR IGNORE pinned_buffers SET buffer_id = ? WHERE buffer_id = ?`,
);

// favorites: same policy as pins — survivor keeps its slot, an absorbed-only
// favorite transfers.
const adoptFavoriteStmt = db.prepare(
  `UPDATE OR IGNORE favorite_buffers SET buffer_id = ? WHERE buffer_id = ?`,
);

// view-state singletons: survivor's row wins, absorbed-only rows transfer.
const adoptNicklistStmt = db.prepare(
  `UPDATE OR IGNORE nicklist_collapsed SET buffer_id = ? WHERE buffer_id = ?`,
);
const adoptNotifyStmt = db.prepare(
  `UPDATE OR IGNORE channel_notify_settings SET buffer_id = ? WHERE buffer_id = ?`,
);
const adoptDraftStmt = db.prepare(
  `UPDATE OR IGNORE user_drafts SET buffer_id = ? WHERE buffer_id = ?`,
);
// followed threads: a thread is its root msgid in the buffer, and the rows
// moved above carry it, so the follow moves too; the survivor's wins a tie.
const adoptThreadFollowsStmt = db.prepare(
  `UPDATE OR IGNORE thread_follows SET buffer_id = ? WHERE buffer_id = ?`,
);
const draftBodyStmt = db.prepare(
  `SELECT body FROM user_drafts WHERE user_id = ? AND buffer_id = ?`,
);

// Channel-property union, mirroring importRow's conflict semantics (autojoin
// = MAX, key = first non-null): a merge must not silently drop the absorbed
// row's autojoin flag or its +k key, which are properties of the CHANNEL both
// rows name. `key` is encrypted at rest; COALESCE copies the opaque blob.
const mergeChannelPropsStmt = db.prepare(`
  UPDATE buffers SET
    autojoin = MAX(autojoin, (SELECT b2.autojoin FROM buffers b2 WHERE b2.id = @absorbed)),
    key = COALESCE(key, (SELECT b2.key FROM buffers b2 WHERE b2.id = @absorbed))
  WHERE id = @survivor
`);

// Re-densify a (user, network)'s pin positions after a merge dropped a row.
const renumberPinsStmt = db.prepare(`
  UPDATE pinned_buffers SET position = (
    SELECT rn - 1 FROM (
      SELECT p2.buffer_id AS bid2,
             ROW_NUMBER() OVER (
               PARTITION BY p2.user_id, p2.network_id ORDER BY p2.position, p2.buffer_id
             ) AS rn
      FROM pinned_buffers p2
      WHERE p2.user_id = pinned_buffers.user_id AND p2.network_id = pinned_buffers.network_id
    ) WHERE bid2 = pinned_buffers.buffer_id
  )
  WHERE user_id = ? AND network_id = ?
`);

/**
 * Absorb one buffer row into another — the merge half of a rename, shared
 * with the CASEMAPPING re-fold pass (#707), where two rows folded apart under
 * the old rule collide under the declared one. Same policies as the rename
 * merge (they ARE the rename merge): repoint history wholesale, furthest read
 * pointer + max clear marker, survivor's pin slot (or adopt), survivor's
 * view-state and draft win (with the absorbed draft adopted when the survivor
 * has none — reported via `draftChanged` so callers can announce it),
 * autojoin/+k union per importRow's channel semantics, visibility is the
 * union, absorbed row deleted, pin positions re-densified. Runs inside the
 * caller's transaction; the caller announces.
 */
export function absorbBufferRow(
  userId: number,
  networkId: number,
  survivor: { id: number; state: string },
  absorbed: { id: number; state: string },
): { draftChanged: boolean } {
  const draftBefore = (draftBodyStmt.get(userId, survivor.id) as { body: string } | undefined)
    ?.body;
  repointMessages.run(survivor.id, absorbed.id);
  repointInputHistory.run(survivor.id, absorbed.id);
  mergeReadsStmt.run({ survivor: survivor.id, absorbed: absorbed.id });
  adoptReadsStmt.run(survivor.id, absorbed.id);
  adoptPinStmt.run(survivor.id, absorbed.id);
  adoptFavoriteStmt.run(survivor.id, absorbed.id);
  adoptNicklistStmt.run(survivor.id, absorbed.id);
  adoptThreadFollowsStmt.run(survivor.id, absorbed.id);
  adoptNotifyStmt.run(survivor.id, absorbed.id);
  adoptDraftStmt.run(survivor.id, absorbed.id);
  mergeChannelPropsStmt.run({ survivor: survivor.id, absorbed: absorbed.id });
  // Visibility is the union: if either side was open, the merged buffer is.
  if (absorbed.state === 'open' && survivor.state !== 'open') setOpenStmt.run(survivor.id);
  // The absorbed row dies; its remaining satellites cascade with it (any
  // UPDATE OR IGNORE above that lost to the survivor left rows behind).
  deleteRowStmt.run(absorbed.id);
  renumberPinsStmt.run(userId, networkId);
  // Favorites density is per user alone (global order). Unlike the pins twin
  // above, the module's renumber is exported (the network-delete route needs
  // it too), so reuse it — it's a bare statement-runner, no transaction of its
  // own, so it nests fine inside the caller's.
  renumberFavorites(userId);
  const draftAfter = (draftBodyStmt.get(userId, survivor.id) as { body: string } | undefined)?.body;
  return { draftChanged: draftAfter !== draftBefore };
}

const work = db.transaction(
  (userId: number, networkId: number, from: string, to: string): RenameResult | undefined => {
    const src = resolveBuffer(userId, networkId, from);
    if (!src) return undefined;
    const noop: RenameResult = {
      renamed: false,
      bufferId: src.id,
      from: src.target,
      to: src.target,
      merged: false,
      draftChanged: false,
      open: src.state === 'open',
    };
    // Sentinels never rename; a rename onto a sentinel name is nonsense.
    if (src.target.startsWith(':') || to.startsWith(':')) return noop;
    const toFolded = foldTargetFor(networkId, to);

    // Casing-only: same identity under the fold, just adopt the new display
    // casing. Announced (the display changed) but never a merge.
    if (toFolded === src.targetFolded) {
      if (src.target === to) return noop;
      setNameStmt.run(to, toFolded, src.id);
      return {
        renamed: true,
        bufferId: src.id,
        from: src.target,
        to,
        merged: false,
        draftChanged: false,
        open: src.state === 'open',
      };
    }

    const dest = resolveBuffer(userId, networkId, to);
    if (!dest) {
      setNameStmt.run(to, toFolded, src.id);
      return {
        renamed: true,
        bufferId: src.id,
        from: src.target,
        to,
        merged: false,
        draftChanged: false,
        open: src.state === 'open',
      };
    }

    // Merge: the destination row is absorbed into the (surviving) source.
    const { draftChanged } = absorbBufferRow(userId, networkId, src, dest);
    setNameStmt.run(to, toFolded, src.id);
    return {
      renamed: true,
      bufferId: src.id,
      from: src.target,
      to,
      merged: true,
      mergedFromBufferId: dest.id,
      draftChanged,
      // Visibility union already applied by absorbBufferRow.
      open: src.state === 'open' || dest.state === 'open',
    };
  },
);

/**
 * Rename (user, network, from) → to, merging if a buffer already holds the
 * new name. One IMMEDIATE transaction — it reads (resolves, draft probe)
 * before it writes, and on a hosted cell a deferred BEGIN in that shape is
 * the Litestream SQLITE_BUSY_SNAPSHOT crash class (db/index.ts:~2022).
 * Returns undefined when the source doesn't exist.
 */
export function renameBuffer(
  userId: number,
  networkId: number,
  from: string,
  to: string,
): RenameResult | undefined {
  if (!to || !from) return undefined;
  return work.immediate(userId, networkId, from, to);
}
