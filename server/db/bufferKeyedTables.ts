// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The registry of every table that stores a buffer target as a string.
//
// Buffers are not normalized: `buffers.id` exists but nothing references it, and
// each table below denormalizes the target as text with no foreign key. That is
// a deliberate trade (see docs on idx_messages_unread — a buffer_id join would
// sit on the hottest read path there is), and the cost of it is this list. Any
// operation that changes a buffer's name has to visit every entry, and one
// that's missed is silent data loss: a rename that leaves a row behind orphans
// the user's draft, or their pin, or their read pointer.
//
// The list has drifted before. `foldBufferCase` carried its own copy, stopped
// being updated around schema 9, and by schema 16 was naming two tables that had
// been dropped. bufferKeyedTables.test.ts introspects the live schema and fails
// when a table with a buffer-shaped column isn't declared here — that test, not
// this comment, is what keeps the list honest.

/** How a rename resolves a row that would collide at the destination. */
export type CollisionPolicy =
  // No uniqueness on the target — every row is rewritten, collisions impossible.
  | 'rewrite'
  // (scope..., target) is unique. A destination row already exists, so the
  // source row is dropped and the destination's value wins.
  | 'destination-wins'
  // Unique, but the two rows carry progress that has to be reconciled rather
  // than picked between. Handled explicitly by the caller, never generically.
  | 'merge';

export interface BufferKeyedTable {
  table: string;
  /** The column holding the buffer target. */
  column: string;
  /**
   * Columns that scope a target to one row, alongside `column` itself. Drives
   * both the collision lookup and the WHERE clause of a per-user rename.
   */
  scope: readonly string[];
  policy: CollisionPolicy;
  /**
   * A second column holding a derived form of the target that must be rewritten
   * in lockstep. Only `buffers` has one (`target_folded`, its actual lookup key).
   */
  derivedColumn?: string;
  /**
   * True when the column is declared COLLATE NOCASE, so case variants already
   * collapse to one row and a case-only fold has nothing to do. Renames still
   * have to rewrite it; only `foldBufferCase` may skip these.
   */
  caseInsensitive?: boolean;
  /**
   * Retired tables kept here so the fold can still repair a database that is
   * mid-upgrade and hasn't dropped them yet. Never present on a fresh install,
   * so every use has to be existence-gated.
   */
  legacy?: boolean;
  /** Dropping a colliding row leaves a position gap that must be renumbered. */
  requiresPinRenumber?: boolean;
  /**
   * The column holds a LIST of targets (CSV or JSON), not one. A whole-column
   * rewrite is wrong for these — the value has to be parsed, the matching
   * element replaced, and the rest left alone — so no generic path may touch
   * them. Declared here so they are visible to the drift test and impossible to
   * forget, not because anything handles them generically.
   */
  listValued?: boolean;
}

export const BUFFER_KEYED_TABLES: readonly BufferKeyedTable[] = [
  // The buffer registry itself. `target` is display casing; `target_folded` is
  // the real lookup key (unique index idx_buffers_key), so both move together or
  // the row becomes unfindable.
  {
    table: 'buffers',
    column: 'target',
    derivedColumn: 'target_folded',
    scope: ['user_id', 'network_id'],
    policy: 'merge',
  },

  // History. By far the largest, and the only one where the rewrite cost is
  // worth thinking about — see renameBuffer's chunking.
  { table: 'messages', column: 'target', scope: ['network_id'], policy: 'rewrite' },

  // Per-buffer input history: id-keyed, many rows per target.
  {
    table: 'input_history',
    column: 'target',
    scope: ['user_id', 'network_id'],
    policy: 'rewrite',
  },

  // Read pointer + /clear marker. Both sides carry progress the user can lose,
  // so a collision keeps the furthest of each rather than picking a row.
  {
    table: 'buffer_reads',
    column: 'target',
    scope: ['user_id', 'network_id'],
    policy: 'merge',
  },

  // Sidebar pins. A collision drops the source row — there is no progress to
  // reconcile, only a slot — but positions are dense per (user, network) and
  // reorderPins assumes 0..n-1, so the drop leaves a gap that must be renumbered
  // afterwards. That post-step is why this is flagged rather than being a plain
  // destination-wins table.
  {
    table: 'pinned_buffers',
    column: 'target',
    scope: ['user_id', 'network_id'],
    policy: 'destination-wins',
    requiresPinRenumber: true,
  },

  // Plain per-buffer preferences: nothing to reconcile, the destination wins.
  {
    table: 'nicklist_collapsed',
    column: 'target',
    scope: ['user_id', 'network_id'],
    policy: 'destination-wins',
  },
  {
    table: 'channel_notify_settings',
    column: 'target',
    scope: ['user_id', 'network_id'],
    policy: 'destination-wins',
  },
  {
    table: 'user_drafts',
    column: 'target',
    scope: ['user_id', 'network_id'],
    policy: 'destination-wins',
  },

  // E2E session state, keyed on `channel`. All COLLATE NOCASE, so these never
  // case-forked and the fold correctly ignores them — but a rename moves a
  // channel to a genuinely different name, and leaving the session state behind
  // would silently break encryption for the renamed channel.
  {
    table: 'e2e_incoming_sessions',
    column: 'channel',
    scope: ['user_id', 'network_id', 'handle'],
    policy: 'destination-wins',
    caseInsensitive: true,
  },
  {
    table: 'e2e_outgoing_sessions',
    column: 'channel',
    scope: ['user_id', 'network_id'],
    policy: 'destination-wins',
    caseInsensitive: true,
  },
  {
    table: 'e2e_channel_config',
    column: 'channel',
    scope: ['user_id', 'network_id'],
    policy: 'destination-wins',
    caseInsensitive: true,
  },
  {
    table: 'e2e_outgoing_recipients',
    column: 'channel',
    scope: ['user_id', 'network_id', 'handle'],
    policy: 'destination-wins',
    caseInsensitive: true,
  },

  // ---- List-valued scopes. ----
  // Both hold a CSV of channel GLOBS, not a single exact target, so neither can
  // be rewritten by the whole-column UPDATE every other entry uses. A rule
  // scoped to the literal `#old` should follow a rename; one scoped to `#old*`
  // is a pattern and must not be rewritten blindly.
  //
  // Nothing handles them yet — the fold skips them (case-folding a glob is
  // safe to defer; the matcher is case-insensitive) and renameBuffer will need
  // bespoke parse-and-replace. They are declared so the gap is visible in the
  // registry and enforced by the drift test rather than being an omission
  // nobody notices, which is exactly how the previous list rotted.
  {
    table: 'highlight_rules',
    column: 'channels',
    scope: ['user_id'],
    policy: 'merge',
    listValued: true,
  },
  {
    table: 'ignored_masks',
    column: 'channels',
    scope: ['user_id', 'network_id'],
    policy: 'merge',
    listValued: true,
  },

  // ---- Retired at schema 16, replaced by the `buffers` registry. ----
  // foldBufferCase runs mid-upgrade, before these are dropped, so it still has
  // to repair them; everything else must skip them. Existence-gated at every
  // use — on a fresh install they were never created.
  {
    table: 'channels',
    column: 'name',
    scope: ['network_id'],
    policy: 'merge',
    legacy: true,
  },
  {
    table: 'closed_buffers',
    column: 'target',
    scope: ['user_id', 'network_id'],
    policy: 'destination-wins',
    legacy: true,
  },
];

/** Live (non-retired) tables — what a rename on a current database must visit. */
export const CURRENT_BUFFER_KEYED_TABLES: readonly BufferKeyedTable[] = BUFFER_KEYED_TABLES.filter(
  (t) => !t.legacy,
);

/**
 * Column names that mean "a buffer target" for drift detection.
 *
 * `channels` is in the list because leaving it out is precisely how
 * `highlight_rules.channels` and `ignored_masks.channels` stayed invisible: the
 * singular `channel` matched the e2e tables, the plural did not match anything,
 * and both CSV columns sailed past a test whose whole job was catching them.
 *
 * This is a heuristic and its limits are real. It cannot catch a column that
 * names the same concept differently — `instance_network.channels_json` (admin
 * autojoin config) and `chanlist_channels.name` (an ephemeral /LIST cache) are
 * both buffer-name-shaped and both invisible here. Neither is per-user buffer
 * state, so neither belongs in a rename; adding `name` to this list would flag
 * half the schema. If you add a buffer-keyed table, name the column `target`.
 */
export const BUFFER_TARGET_COLUMN_NAMES: readonly string[] = ['target', 'channel', 'channels'];

/**
 * Tables that have a column named like a buffer target but genuinely aren't
 * buffer-keyed. Listed explicitly so the drift test stays a real assertion
 * rather than something that gets loosened the first time it fires.
 */
export const NON_BUFFER_TARGET_TABLES: readonly string[] = [];

/** The declared entry for a table, or undefined when it isn't buffer-keyed. */
export function bufferKeyedTable(table: string): BufferKeyedTable | undefined {
  return BUFFER_KEYED_TABLES.find((t) => t.table === table);
}
