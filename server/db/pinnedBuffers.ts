// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** A row from the `pinned_buffers` table. */
export interface PinnedBuffer {
  user_id: number;
  network_id: number;
  target: string;
  position: number;
  created_at: string;
}

const listForUserNetworkStmt = db.prepare(`
  SELECT target FROM pinned_buffers
  WHERE user_id = ? AND network_id = ?
  ORDER BY position ASC, target ASC
`);

const listForUserStmt = db.prepare(`
  SELECT network_id AS networkId, target FROM pinned_buffers
  WHERE user_id = ?
  ORDER BY network_id ASC, position ASC, target ASC
`);

const nextPositionStmt = db.prepare(`
  SELECT COALESCE(MAX(position), -1) + 1 AS next
  FROM pinned_buffers
  WHERE user_id = ? AND network_id = ?
`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO pinned_buffers (user_id, network_id, target, position)
  VALUES (?, ?, ?, ?)
`);

const deleteStmt = db.prepare(`
  DELETE FROM pinned_buffers
  WHERE user_id = ? AND network_id = ? AND target = ?
`);

const allForUserNetworkStmt = db.prepare(`
  SELECT target, position FROM pinned_buffers
  WHERE user_id = ? AND network_id = ?
  ORDER BY position ASC
`);

const setPositionStmt = db.prepare(`
  UPDATE pinned_buffers SET position = ?
  WHERE user_id = ? AND network_id = ? AND target = ?
`);

export function listPinnedForUserNetwork(userId: number, networkId: number): string[] {
  return (listForUserNetworkStmt.all(userId, networkId) as Array<{ target: string }>).map(
    (r) => r.target,
  );
}

export function listPinnedForUser(userId: number): Map<number, string[]> {
  const byNetwork = new Map<number, string[]>();
  for (const row of listForUserStmt.all(userId) as Array<{
    networkId: number;
    target: string;
  }>) {
    if (!byNetwork.has(row.networkId)) byNetwork.set(row.networkId, []);
    byNetwork.get(row.networkId)!.push(row.target);
  }
  return byNetwork;
}

// Returns the new ordered target list for the (user, network). No-op if the
// row already exists (idempotent — second pin of the same target keeps the
// existing position rather than creating a duplicate or moving it).
export function pinBuffer(userId: number, networkId: number, target: string): string[] {
  const tx = db.transaction(() => {
    const { next } = nextPositionStmt.get(userId, networkId) as { next: number };
    insertStmt.run(userId, networkId, target, next);
  });
  tx();
  return listPinnedForUserNetwork(userId, networkId);
}

// Unpin and renumber remaining rows to keep positions dense (0..n-1). Returns
// the new ordered target list.
export function unpinBuffer(userId: number, networkId: number, target: string): string[] {
  const tx = db.transaction(() => {
    deleteStmt.run(userId, networkId, target);
    const remaining = allForUserNetworkStmt.all(userId, networkId) as Array<{
      target: string;
      position: number;
    }>;
    let i = 0;
    for (const row of remaining) {
      if (row.position !== i) {
        setPositionStmt.run(i, userId, networkId, row.target);
      }
      i += 1;
    }
  });
  tx();
  return listPinnedForUserNetwork(userId, networkId);
}

// Unpin every buffer matching `target` case-insensitively. IRC targets are
// case-insensitive but a pin row stores one canonical casing, so a caller that
// only has the server's current casing (e.g. close-buffer, where the buffer may
// have been re-cased by the server) can still find and remove the stranded pin.
// The schema's PRIMARY KEY is on the raw target (no NOCASE), so two case
// variants of the same channel can coexist as separate rows — remove ALL of
// them in one transaction and renumber once, or closing one would leave the
// other as an invisible orphan. Returns the new ordered list when at least one
// row was removed, or null when nothing matched — callers use null to skip the
// pins-changed broadcast. Matches the case-folding the snapshot already applies
// to closed buffers (issue #405).
export function unpinBufferCaseInsensitive(
  userId: number,
  networkId: number,
  target: string,
): string[] | null {
  const lower = target.toLowerCase();
  const matches = listPinnedForUserNetwork(userId, networkId).filter(
    (t) => t.toLowerCase() === lower,
  );
  if (matches.length === 0) return null;
  const tx = db.transaction(() => {
    for (const m of matches) deleteStmt.run(userId, networkId, m);
    const remaining = allForUserNetworkStmt.all(userId, networkId) as Array<{
      target: string;
      position: number;
    }>;
    let i = 0;
    for (const row of remaining) {
      if (row.position !== i) {
        setPositionStmt.run(i, userId, networkId, row.target);
      }
      i += 1;
    }
  });
  tx();
  return listPinnedForUserNetwork(userId, networkId);
}

// Rewrite the order for a (user, network). Every supplied target must currently
// be pinned (and appear at most once); an unknown or duplicated target means the
// client is working from a stale set (e.g. a concurrent pin/unpin from another
// tab), so we return null and let the caller echo the authoritative order.
//
// The supplied list may be a strict SUBSET of the pinned set. The client only
// renders pins that resolve to a visible buffer — it drops any pin whose buffer
// is closed/parted/case-mismatched, or that is a friend's primary DM (shown
// under FRIENDS) — so a drag legitimately reorders only the rows the user can
// see. We honor that order for the supplied targets and keep the unmentioned
// ("hidden") pins after them in their existing relative order. Requiring an
// exact set match instead made a single invisible orphan pin wedge every
// reorder for that network (issue #405). On success returns the new full
// ordered target list.
export function reorderPins(userId: number, networkId: number, targets: string[]): string[] | null {
  const currentOrdered = listPinnedForUserNetwork(userId, networkId);
  const current = new Set(currentOrdered);
  const seen = new Set<string>();
  for (const t of targets) {
    if (!current.has(t) || seen.has(t)) return null;
    seen.add(t);
  }
  const next = [...targets, ...currentOrdered.filter((t) => !seen.has(t))];
  const tx = db.transaction(() => {
    let i = 0;
    for (const t of next) {
      setPositionStmt.run(i, userId, networkId, t);
      i += 1;
    }
  });
  tx();
  return next;
}
