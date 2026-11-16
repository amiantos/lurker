// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { foldTargetWith } from './casemapping.js';
import type { Casemapping } from './casemapping.js';
import { absorbBufferRow } from './renameBuffer.js';
import { kickMergeDrain } from './bufferMergeDrain.js';
import { invalidateCasemappingCache } from './buffers.js';
import { moveRuleScopes, type RuleScopeMoves } from './ruleScopeRename.js';

// Re-fold one network's buffer registry under a newly-declared CASEMAPPING
// (#707). Runs when the capture path (ircConnection's raw-005 token scan)
// sees a declared mapping that differs from what's stored — first contact
// with a declaring server included, since every existing row was folded with
// the legacy Unicode-lowercase rule. This pass is also the mapping's ONE
// writer: the store rides inside the refold transaction (see below).
//
// Two things can change:
//
//  - A row's stored fold no longer matches the declared rule (`#Ärger` was
//    folded to `#ärger`; ascii-family rules leave `Ä` alone). Rewritten in
//    place — nothing user-visible, target_folded never leaves the server.
//  - Two rows now fold TOGETHER (`#foo[bar]` and `#foo{bar}` under rfc1459).
//    Merged via the rename machinery's absorb, one buffer-renamed frame per
//    absorbed row (the caller announces) — clients handle it exactly like a
//    DM nick-collision merge.
//
// Survivor choice mirrors what the fold repair has always preferred (see
// foldBufferCase: "the buffer you actually used"): an open row beats a closed
// one, then the row with the most recent message, then the older row id — a
// deterministic tiebreak, not a policy.

export interface RefoldMerge {
  survivorId: number;
  survivorTarget: string;
  absorbedId: number;
  absorbedTarget: string;
  /** Same contract as RenameResult.draftChanged: the surviving draft differs
   *  from what the survivor had before the absorb. */
  draftChanged: boolean;
  /** Same contract as RenameResult.open: a closed survivor (both twins were
   *  closed — the ranking puts any open row first, so this is constant per
   *  group) must NOT be announced, or clients materialize a sidebar row for
   *  a conversation closed everywhere. */
  survivorOpen: boolean;
  /** Rule lists whose scopes moved from the absorbed spelling to the
   *  survivor's (#719); the caller invalidates and announces them. */
  rulesMoved: RuleScopeMoves;
}

interface Row {
  id: number;
  target: string;
  target_folded: string;
  state: string;
}

// Sentinels (kind server/system) never re-fold — their ':'-prefixed names are
// ours, not the network's. A 'dcc' row DOES: `=Nick` folds like any other
// target, so leaving it out would strand a stale target_folded and let the next
// ensureBuffer('=Nick') mint a duplicate buffer under the new mapping. A row
// an earlier merge is still draining (bufferMergeDrain.ts) is not a buffer.
const rowsStmt = db.prepare(`
  SELECT id, target, target_folded, state FROM buffers
  WHERE user_id = ? AND network_id = ? AND kind IN ('channel', 'dm', 'dcc')
    AND merged_into IS NULL
`);
const lastMessageStmt = db.prepare(`SELECT MAX(id) AS m FROM messages WHERE buffer_id = ?`);
const setFoldedStmt = db.prepare(`UPDATE buffers SET target_folded = ? WHERE id = ?`);
const storeMappingStmt = db.prepare(`UPDATE networks SET casemapping = ? WHERE id = ?`);

const work = db.transaction(
  (
    userId: number,
    networkId: number,
    mapping: Casemapping,
    chunkRows: number | undefined,
  ): { merges: RefoldMerge[]; draining: boolean } => {
    // The mapping is stored INSIDE the refold transaction, not before it: the
    // stored value is the capture path's only "already done" signal, so a
    // mapping committed ahead of a refold that then failed (Litestream write
    // contention, a crash between the two) would never be retried — every
    // lookup would fold with the new rule against rows still holding legacy
    // folds, minting the exact duplicate-buffer split this seam exists to
    // prevent. Fail together, retry together on the next 005.
    storeMappingStmt.run(mapping, networkId);
    const rows = rowsStmt.all(userId, networkId) as Row[];
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const folded = foldTargetWith(mapping, row.target);
      const group = groups.get(folded);
      if (group) group.push(row);
      else groups.set(folded, [row]);
    }

    const merges: RefoldMerge[] = [];
    let draining = false;
    // Surviving row id → its fold under the new rule.
    const finalFolds: { row: Row; folded: string }[] = [];
    for (const [folded, group] of groups) {
      let survivor = group[0];
      if (group.length > 1) {
        const ranked = group
          .map((row) => ({
            row,
            open: row.state === 'open' ? 1 : 0,
            last: Number((lastMessageStmt.get(row.id) as { m: number | null }).m ?? 0),
          }))
          .sort((a, b) => b.open - a.open || b.last - a.last || a.row.id - b.row.id);
        survivor = ranked[0].row;
        for (const { row: absorbed } of ranked.slice(1)) {
          const absorb = absorbBufferRow(userId, networkId, survivor, absorbed, chunkRows);
          const { draftChanged } = absorb;
          if (absorb.draining) draining = true;
          // Keep the in-memory copy honest with the union absorbBufferRow may
          // have just written, so later absorbs in this group pass the
          // already-open survivor state instead of re-flipping it.
          if (absorbed.state === 'open') survivor.state = 'open';
          // A mute on the spelling that goes away would stop matching: the
          // matcher compares text, and `#foo[bar]` is not `#foo{bar}` to it.
          const rulesMoved = moveRuleScopes(
            userId,
            networkId,
            absorbed.target,
            survivor.target,
            (name) => foldTargetWith(mapping, name),
          );
          merges.push({
            survivorId: survivor.id,
            survivorTarget: survivor.target,
            absorbedId: absorbed.id,
            absorbedTarget: absorbed.target,
            draftChanged,
            survivorOpen: survivor.state === 'open',
            rulesMoved,
          });
        }
      }
      finalFolds.push({ row: survivor, folded });
    }

    // Rewrite drifted folds in one pass. Order can't trip idx_buffers_key:
    // the final folds are unique by construction (one survivor per group),
    // and a transient collision would need row A's NEW fold to equal row B's
    // still-stored OLD fold — checked case-by-case across the four
    // implemented rules, any pair in that shape already folded together
    // under the old rule and merged above, so B's slot is never occupied
    // when A's rewrite lands.
    for (const { row, folded } of finalFolds) {
      if (row.target_folded !== folded) setFoldedStmt.run(folded, row.id);
    }
    return { merges, draining };
  },
);

/**
 * Re-fold every buffer of (user, network) under `mapping`, merging rows that
 * now collide. Returns the merges for the caller to announce (one
 * buffer-renamed frame each, merged: true). One IMMEDIATE transaction — it
 * reads before it writes, the Litestream SQLITE_BUSY_SNAPSHOT shape. History
 * past the first chunk of a merge follows in the background (#1307).
 */
export function refoldNetworkBuffers(
  userId: number,
  networkId: number,
  mapping: Casemapping,
  chunkRows?: number,
): RefoldMerge[] {
  const { merges, draining } = work.immediate(userId, networkId, mapping, chunkRows);
  if (draining) kickMergeDrain(chunkRows);
  // Only after the commit: an invalidation before a rolled-back store would
  // just re-read the old value, but this ordering keeps the cache unable to
  // ever run ahead of the database.
  invalidateCasemappingCache(networkId);
  return merges;
}
