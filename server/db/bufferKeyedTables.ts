// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The registry of buffer-scoped tables, and where each stands in the
// name→buffer_id normalization (#695).
//
// Historically a buffer's NAME was its identity: every table below denormalized
// the target as text with no foreign key, and the cost was a class of "two
// places storing the name disagree" bugs — a rename or case-fold had to visit
// every entry here and get each one's collision semantics right (the closed
// PR #706 measured that cost at ~35 review findings). Normalized, each table
// references buffers(id), the name lives in exactly one place, and a rename is
// a single-row UPDATE.
//
// `status` records where each table is on that path:
//   - 'buffer_id'    — normalized: keyed by a buffer_id FK to buffers(id).
//   - 'pending'      — still name-keyed; scheduled for the satellite rebuild.
//   - 'glob-list'    — a CSV of channel GLOBS that may span networks. These
//                      are match patterns, not identities: they cannot
//                      reference a buffer_id and deliberately do not follow
//                      renames.
//   - 'wire-context' — keyed by an IRC-side context string that only
//                      COINCIDES with a buffer name sometimes. The e2e tables'
//                      `channel` is the canonical case: it also holds
//                      `@ident@host` DM pseudochannels (no buffer row exists
//                      or should), the literal '@' from empty-handle call
//                      sites, and peer-supplied names for channels this user
//                      never joined. These live on the IRC side of the
//                      name↔id boundary — like IrcConnection's in-memory maps
//                      — and must NEVER grow a buffer_id (the drift test
//                      enforces it). DM contexts are already rename-proof
//                      (host-keyed); a channel rename starting a fresh crypto
//                      context is correct, not a bug.
//
// The companion test introspects the live schema in BOTH directions, so this
// list cannot silently drift from reality (its predecessor did exactly that:
// a hand-copied list in foldBufferCase stopped being updated around schema 9
// and by 16 named two dropped tables). The test — not this comment — is what
// keeps it honest.

export type BufferTableStatus = 'buffer_id' | 'pending' | 'glob-list' | 'wire-context';

export interface BufferScopedTable {
  table: string;
  status: BufferTableStatus;
  /**
   * The target-shaped text column. For 'pending' this is the current key; for
   * 'glob-list' the pattern column; for 'buffer_id' tables it appears only when
   * deliberately retained (see `tombstone`).
   */
  targetColumn?: string;
  /**
   * True when `targetColumn` survives normalization as a write-only log —
   * "the target as observed at insert time", never a key, never rewritten.
   * messages.target: dropping it would rewrite a multi-hundred-MB table for a
   * few bytes a row, and as a non-key it can no longer disagree with anything.
   */
  tombstone?: boolean;
  /** Values of targetColumn that are sentinels, not buffer names. */
  excludeValues?: readonly string[];
  /** targetColumn is declared COLLATE NOCASE (cross-checked against DDL). */
  caseInsensitive?: boolean;
  /** Immutable scope columns that stay denormalized alongside the key. */
  scope: readonly string[];
  note: string;
}

export const BUFFER_SCOPED_TABLES: readonly BufferScopedTable[] = [
  {
    table: 'messages',
    status: 'buffer_id',
    targetColumn: 'target',
    tombstone: true,
    scope: ['network_id'],
    note: 'chat history — by far the largest; buffer_id backfilled at v17',
  },
  {
    table: 'buffer_reads',
    status: 'buffer_id',
    scope: ['user_id'],
    note: 'read pointer + /clear marker; PK (user_id, buffer_id) since v18',
  },
  {
    table: 'input_history',
    status: 'buffer_id',
    scope: ['user_id'],
    note: 'up-arrow input recall; buffer_id-keyed since v18',
  },
  {
    table: 'pinned_buffers',
    status: 'buffer_id',
    scope: ['user_id', 'network_id'],
    note: 'sidebar pins; network_id kept — position density is per (user, network)',
  },
  {
    table: 'favorite_buffers',
    status: 'buffer_id',
    scope: ['user_id'],
    note: 'buffer favorites (Friends/Contacts replacement); one global per-user order, born id-keyed at v19',
  },
  {
    table: 'nicklist_collapsed',
    status: 'buffer_id',
    scope: ['user_id'],
    note: 'per-channel nicklist toggle; buffer_id-keyed since v18',
  },
  {
    table: 'channel_notify_settings',
    status: 'buffer_id',
    scope: ['user_id'],
    note: "notify_always; the dead 'muted' column died in the v18 rebuild",
  },
  {
    table: 'user_drafts',
    status: 'buffer_id',
    scope: ['user_id'],
    note: 'half-typed composer input; buffer_id-keyed since v18',
  },
  {
    table: 'thread_follows',
    status: 'buffer_id',
    scope: ['user_id'],
    note: 'followed reply threads (buffer, root msgid); born buffer_id-keyed',
  },
  {
    table: 'buffer_retention',
    status: 'buffer_id',
    scope: ['user_id'],
    note: 'per-buffer retention line-cap override; born buffer_id-keyed',
  },
  {
    table: 'e2e_incoming_sessions',
    status: 'wire-context',
    targetColumn: 'channel',
    caseInsensitive: true,
    scope: ['user_id', 'network_id'],
    note: 'RPE2E incoming session keys',
  },
  {
    table: 'e2e_outgoing_sessions',
    status: 'wire-context',
    targetColumn: 'channel',
    caseInsensitive: true,
    scope: ['user_id', 'network_id'],
    note: 'RPE2E outgoing session keys',
  },
  {
    table: 'e2e_channel_config',
    status: 'wire-context',
    targetColumn: 'channel',
    caseInsensitive: true,
    scope: ['user_id', 'network_id'],
    note: 'per-channel E2E enable/mode',
  },
  {
    table: 'e2e_outgoing_recipients',
    status: 'wire-context',
    targetColumn: 'channel',
    caseInsensitive: true,
    scope: ['user_id', 'network_id'],
    note: 'RPE2E first-sent bookkeeping',
  },
  {
    table: 'e2e_autotrust',
    status: 'wire-context',
    targetColumn: 'scope',
    excludeValues: ['global'],
    caseInsensitive: true,
    scope: ['user_id', 'network_id'],
    note: "auto-trust rule; scope is 'global' or a channel context string, never an id",
  },
  {
    table: 'highlight_rules',
    status: 'glob-list',
    targetColumn: 'channels',
    scope: ['user_id'],
    note: 'CSV of channel globs, may span networks — never id-keyed',
  },
  {
    table: 'ignored_masks',
    status: 'glob-list',
    targetColumn: 'channels',
    scope: ['user_id', 'network_id'],
    note: 'CSV of channel globs — never id-keyed',
  },
];

/** Tables still keyed by name — the satellite-rebuild worklist. */
export const PENDING_BUFFER_TABLES: readonly BufferScopedTable[] = BUFFER_SCOPED_TABLES.filter(
  (t) => t.status === 'pending',
);

/**
 * Column names that mean "a buffer target" for drift detection.
 *
 * `channels` is in the list because leaving it out is precisely how
 * `highlight_rules.channels` and `ignored_masks.channels` stayed invisible to
 * an earlier version of this sweep: the singular `channel` matched the e2e
 * tables, the plural matched nothing. `scope` is here for `e2e_autotrust`,
 * which hid the same way — it names a buffer without using any word the list
 * knew about.
 *
 * This is a heuristic and its limits are real: it cannot catch a column that
 * names the concept differently again — `instance_network.channels_json`
 * (admin autojoin config) and `chanlist_channels.name` (ephemeral /LIST cache)
 * are both buffer-name-shaped and both invisible here. Neither is per-user
 * buffer state, so neither belongs in the registry. If you add a buffer-scoped
 * table, key it by `buffer_id`; if it must carry a name, call the column
 * `target` so the sweep sees it.
 */
export const BUFFER_TARGET_COLUMN_NAMES: readonly string[] = [
  'target',
  'channel',
  'channels',
  'scope',
];

/**
 * Tables with a column named like a buffer target that genuinely isn't one.
 * Listed explicitly so the drift test stays a real assertion rather than
 * something that gets loosened the first time it fires.
 */
export const NON_BUFFER_TARGET_TABLES: readonly string[] = [
  'api_tokens', // scope = permission scope
  'system_messages', // scope = message origin ('lurker')
  'uploader_config', // scope = 'instance' | 'user'
  'buffers', // target/target_folded ARE the name — the one place it lives
];

/**
 * Nick-keyed per-user state. Not buffer-scoped — these attach to a person, not
 * a buffer — but for a DM the two coincide, so a peer's nick change moves the
 * buffer and leaves these behind under the old nick. Deliberately NOT in the
 * registry: whether a nick note follows its subject through a nick change is a
 * product decision the DM-rename work makes explicitly, not a side effect.
 */
export const NICK_KEYED_TABLES: readonly string[] = [
  'user_nick_notes',
  'user_relay_bots',
  'peer_presence_state',
  'dcc_transfers',
];

/** The declared entry for a table, or undefined when it isn't buffer-scoped. */
export function bufferScopedTable(table: string): BufferScopedTable | undefined {
  return BUFFER_SCOPED_TABLES.find((t) => t.table === table);
}
