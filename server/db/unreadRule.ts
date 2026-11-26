// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What counts as unread, written once. The stored per-buffer counter
// (db/unreadCounts.ts), the triggers that keep it (db/index.ts) and the capped
// walk it replaces (db/messages.ts) all build their SQL from here, so the three
// can't disagree about a row. No db import: index.ts reads this while it is
// still building the schema.

// Types that count as "real content" for the unread badge in a channel or DM.
// Membership churn (join/part/quit/kick/nick/mode/topic), MOTD, and away markers
// are persisted for the buffer log but don't bump the badge. `error` is excluded
// HERE but the `:server:` buffer does count it (SERVER_COUNTABLE_TYPES) — a
// killed/banned/disconnect line should badge the server tab.
export const COUNTABLE_TYPES = new Set(['message', 'action', 'notice']);

// The server pseudo-buffer also counts `error` lines (killed/banned/connection
// failures, and the QUIT-echo disconnect line — all SHOULD badge it). Derived
// from COUNTABLE_TYPES so the two can't drift.
export const SERVER_COUNTABLE_TYPES = new Set([...COUNTABLE_TYPES, 'error']);

const sqlList = (types: Set<string>) => `('${[...types].join("','")}')`;
export const COUNTABLE_TYPES_SQL = sqlList(COUNTABLE_TYPES);
export const SERVER_COUNTABLE_TYPES_SQL = sqlList(SERVER_COUNTABLE_TYPES);

/** Whether a buffer is a `:server:` pseudo-buffer, by its target. */
export const SERVER_TARGET_PREFIX = ':server:';
export function isServerTarget(target: string): boolean {
  return target.startsWith(SERVER_TARGET_PREFIX);
}

/**
 * Whether a message row counts toward its buffer's unread, as SQL.
 * `row` is how the statement names the message (`new`, `old`, an alias, or ''
 * for bare columns); `serverBuffer` is an SQL expression that is true for a
 * `:server:` buffer. The server buffer adds `error` and the notability filter
 * (#470: Lurker's own connection-status notices are notable = 0).
 */
export function countableSql(row: string, serverBuffer: string): string {
  const c = row ? `${row}.` : '';
  return `(${c}from_ignored = 0 AND CASE WHEN ${serverBuffer}
      THEN ${c}type IN ${SERVER_COUNTABLE_TYPES_SQL} AND ${c}notable = 1
      ELSE ${c}type IN ${COUNTABLE_TYPES_SQL} END)`;
}

/** `buffers` columns → whether that row is a `:server:` buffer, as SQL. */
export const serverBufferSql = (alias: string) =>
  `(substr(${alias ? `${alias}.` : ''}target, 1, ${SERVER_TARGET_PREFIX.length}) = '${SERVER_TARGET_PREFIX}')`;

/**
 * Whether a countable row is one reply threads hide from the channel
 * (`chat.threads`, #1225): a reply that is not a highlight. A highlighted reply
 * (a rule matched, or it answers one of the user's lines) stays in the channel's
 * count because it is exactly what still pulls the user in.
 */
export function hiddenReplySql(row: string): string {
  const c = row ? `${row}.` : '';
  return `(${c}reply_root_msgid IS NOT NULL AND ${c}matched_rule_id IS NULL AND ${c}reply_to_self = 0)`;
}

/** The message columns the rule reads: a change to any of them can move a count. */
export const UNREAD_RULE_COLUMNS = [
  'buffer_id',
  'type',
  'from_ignored',
  'notable',
  'reply_root_msgid',
  'matched_rule_id',
  'reply_to_self',
] as const;
