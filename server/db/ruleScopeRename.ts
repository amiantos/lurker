// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { parseChannelList } from '../../shared/channels.js';

// Rule scopes follow a buffer through a rename or a merge (#719).
//
// A channel mute is an ignore rule scoped to the channel's name, and a
// highlight or ignore rule can be scoped to a list of names too
// (`ignored_masks.channels`, `highlight_rules.channels`). Those lists are
// patterns, not identities, so they cannot hold a buffer id, and until this
// they stayed behind when the name moved: an op renaming `#old` to `#new`
// unmuted it for everyone who had it muted.
//
// What moves is an entry that IS the old name: equal to it under the network's
// fold. A glob that merely matched it (`#old*`) is a statement about names and
// is left as the user wrote it.
//
// A rule that applies to this network alone has the entry REPLACED. A rule
// that spans others (a global ignore rule; a highlight rule with no network,
// or several) has the new name ADDED beside the old one, because the same
// entry also means `#old` everywhere else, and the old name on this network no
// longer exists for it to match.
//
// Every function here runs inside the caller's transaction.

/** Which rule lists changed, for the caller to invalidate and announce. */
export interface RuleScopeMoves {
  /** Ignore buckets touched: a network id, or null for the global one. */
  ignore: (number | null)[];
  highlight: boolean;
}

export const NO_RULE_SCOPE_MOVES: RuleScopeMoves = { ignore: [], highlight: false };

/**
 * `list` with the buffer's old name moved to its new one, or null when no
 * entry names the old buffer. The matcher compares case-insensitively
 * (shared/ignoreMatch buildChannelMatcher), so an entry that already reads as
 * the new name under that comparison needs nothing: a rename that only
 * changes case never rewrites, and neither does a merge of two spellings a
 * rule already covers.
 */
export function moveScopeEntry(
  list: readonly string[],
  from: string,
  to: string,
  fold: (name: string) => string,
  replace: boolean,
): string[] | null {
  const fromFolded = fold(from);
  const toLower = to.toLowerCase();
  const names = (entry: string) => fold(entry) === fromFolded && entry.toLowerCase() !== toLower;
  if (!list.some(names)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (entry: string) => {
    const key = entry.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const entry of list) {
    if (!names(entry)) push(entry);
    else if (replace) push(to);
    else {
      push(entry);
      push(to);
    }
  }
  return out;
}

interface IgnoreScopeRow {
  id: number;
  networkId: number | null;
  mask: string | null;
  channels: string;
  pattern: string | null;
  patternKind: string;
  levels: string;
  isExcept: number;
  expiresAt: string | null;
}

const ignoreRowsStmt = db.prepare(`
  SELECT id, network_id AS networkId, mask, channels, pattern,
         pattern_kind AS patternKind, levels, is_except AS isExcept,
         expires_at AS expiresAt
  FROM ignored_masks
  WHERE user_id = ? AND (network_id = ? OR network_id IS NULL) AND channels IS NOT NULL
  ORDER BY id ASC
`);
// The same identity addRule dedupes on (ignoredMasks findIdenticalStmt): every
// dimension but the expiry.
const ignoreTwinStmt = db.prepare(`
  SELECT id, expires_at AS expiresAt FROM ignored_masks
  WHERE user_id = @userId AND network_id IS @networkId AND id != @id
    AND IFNULL(mask, '') = IFNULL(@mask, '') COLLATE NOCASE
    AND channels = @channels
    AND IFNULL(pattern, '') = IFNULL(@pattern, '')
    AND pattern_kind = @patternKind
    AND levels = @levels
    AND is_except = @isExcept
  LIMIT 1
`);
const ignoreSetChannelsStmt = db.prepare(`UPDATE ignored_masks SET channels = ? WHERE id = ?`);
const ignoreSetExpiryStmt = db.prepare(`UPDATE ignored_masks SET expires_at = ? WHERE id = ?`);
const ignoreDeleteStmt = db.prepare(`DELETE FROM ignored_masks WHERE id = ?`);

// The longer-lived of two expiries; null is "never".
function laterExpiry(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function moveIgnoreScopes(
  userId: number,
  networkId: number,
  from: string,
  to: string,
  fold: (name: string) => string,
): (number | null)[] {
  const touched = new Set<number | null>();
  // Ignore scopes are stored lowercased (the menu and the parser both write
  // them that way, and a later toggle dedupes on the exact text).
  const toStored = to.toLowerCase();
  for (const row of ignoreRowsStmt.all(userId, networkId) as IgnoreScopeRow[]) {
    const moved = moveScopeEntry(
      row.channels.split(',').filter(Boolean),
      from,
      toStored,
      fold,
      row.networkId !== null,
    );
    if (!moved) continue;
    const channels = moved.join(',');
    touched.add(row.networkId);
    // The new name may already carry this very rule: both sides of a merge
    // were muted, or the channel was renamed back to a name muted before.
    // Two identical rows would show twice in the list and one toggle would
    // remove only one, so they become one, keeping the longer life.
    const twin = ignoreTwinStmt.get({ ...row, userId, channels }) as
      | { id: number; expiresAt: string | null }
      | undefined;
    if (twin) {
      const expiresAt = laterExpiry(row.expiresAt, twin.expiresAt);
      if (expiresAt !== twin.expiresAt) ignoreSetExpiryStmt.run(expiresAt, twin.id);
      ignoreDeleteStmt.run(row.id);
    } else {
      ignoreSetChannelsStmt.run(channels, row.id);
    }
  }
  return [...touched];
}

const highlightRowsStmt = db.prepare(`
  SELECT r.id, r.channels,
         (SELECT COUNT(*) FROM highlight_rule_networks j WHERE j.rule_id = r.id) AS networks,
         EXISTS (SELECT 1 FROM highlight_rule_networks j
                  WHERE j.rule_id = r.id AND j.network_id = @networkId) AS here
  FROM highlight_rules r
  WHERE r.user_id = @userId AND r.channels IS NOT NULL
  ORDER BY r.id ASC
`);
const highlightSetChannelsStmt = db.prepare(`UPDATE highlight_rules SET channels = ? WHERE id = ?`);

function moveHighlightScopes(
  userId: number,
  networkId: number,
  from: string,
  to: string,
  fold: (name: string) => string,
): boolean {
  let touched = false;
  // Read back lowercased whatever was typed (parseChannelList), so the new
  // name is written the way the rest of the list will read.
  const toStored = to.toLowerCase();
  const rows = highlightRowsStmt.all({ userId, networkId }) as {
    id: number;
    channels: string;
    networks: number;
    here: number;
  }[];
  for (const row of rows) {
    // No junction row is a rule for every network; otherwise it has to name
    // this one to have applied to the buffer at all.
    if (row.networks > 0 && !row.here) continue;
    const moved = moveScopeEntry(
      parseChannelList(row.channels),
      from,
      toStored,
      fold,
      row.networks === 1 && !!row.here,
    );
    if (!moved) continue;
    highlightSetChannelsStmt.run(moved.join(','), row.id);
    touched = true;
  }
  return touched;
}

/**
 * Move every rule scope that names the buffer `from` to `to`, for one user on
 * one network. `fold` is the network's case fold, passed in because the
 * casemapping refold runs this under a mapping it has not stored yet.
 */
export function moveRuleScopes(
  userId: number,
  networkId: number,
  from: string,
  to: string,
  fold: (name: string) => string,
): RuleScopeMoves {
  return {
    ignore: moveIgnoreScopes(userId, networkId, from, to, fold),
    highlight: moveHighlightScopes(userId, networkId, from, to, fold),
  };
}

/** Two results as one, for a caller that makes several moves in a pass. */
export function mergeRuleScopeMoves(a: RuleScopeMoves, b: RuleScopeMoves): RuleScopeMoves {
  return {
    ignore: [...new Set([...a.ignore, ...b.ignore])],
    highlight: a.highlight || b.highlight,
  };
}
