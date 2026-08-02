// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';
import { foldTarget } from './buffers.js';
import { BUFFER_KEYED_TABLES, bufferKeyedTable } from './bufferKeyedTables.js';

// Move a buffer to a new name, across every table that stores it.
//
// The one primitive behind both things that rename a buffer: a channel RENAME
// (IRCv3 draft/channel-rename) and a DM peer changing nick. Buffers aren't
// normalized — see bufferKeyedTables.ts for why — so "rename" means visiting
// thirteen tables, and the registry is what makes that list auditable instead of
// remembered.
//
// ## Why this is one synchronous transaction
//
// The obvious worry is cost: measured on a synthetic 1M-message channel with the
// real schema and indexes, the `messages` rewrite alone is ~1.2s (3.5s before
// the messages_au guard). That blocks the event loop, which on this codebase
// has form — a synchronous snapshot once starved it hard enough to trip
// irc-framework's ping timeouts.
//
// Chunking it with setImmediate looks like the fix and isn't, for two reasons
// that both come back to there being exactly ONE shared SQLite connection:
//
//   1. Chunking INSIDE a transaction is unsafe. Yielding to the event loop with
//      a write transaction open means any other write that runs in the meantime
//      executes on the same connection, inside our transaction — and rolls back
//      with us if we fail. That converts a slow rename into a correctness bug.
//
//   2. Chunking WITHOUT a transaction gives up atomicity, and buys nothing:
//      other work still can't touch the database while our statement is in
//      SQLite's C code, because it's the same connection. The event loop would
//      be free to run everything except the thing it's waiting on.
//
// So the honest trade is a slower, atomic rename over a faster, half-applied
// one. A half-applied rename splits a buffer's history across two names with no
// record of which rows moved; there is no recovery for that short of a fold.
// `estimateCost` is exported so callers can decide (warn, defer, refuse) before
// committing to the stall.

/** Rows that would move, per table — the pre-flight for a rename's cost. */
export function estimateCost(
  userId: number,
  networkId: number,
  from: string,
): { rowsByTable: Record<string, number>; total: number } {
  const canonical = canonicalName(userId, networkId, from);
  const rowsByTable: Record<string, number> = {};
  let total = 0;
  for (const t of BUFFER_KEYED_TABLES) {
    // Counts what the rename will MOVE, so it skips exactly what the rename
    // skips — keyed off the same predicate as the dispatch, not off `listValued`,
    // which happens to select the same tables today and needn't tomorrow.
    if (!hasRenameHandler(t.table) || !tableExists(t.table)) continue;
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${t.table}
            WHERE ${scopeSql(t.table, t.scope)} AND ${t.column} = ?`,
        )
        .get(...scopeArgs(t.scope, userId, networkId), canonical) as { n: number }
    ).n;
    if (n > 0) {
      rowsByTable[t.table] = n;
      total += n;
    }
  }
  return { rowsByTable, total };
}

/**
 * Registry tables this primitive deliberately does not move, with the reason.
 *
 * Both hold a comma-separated list of channel scopes, and both can govern more
 * than the network being renamed: a highlight rule's network scope lives in a
 * junction table (no rows = every network), and an ignore rule with a NULL
 * network_id is global by definition. So "#foo was renamed on network 3" does
 * not license rewriting a rule that also governs #foo on network 7 — and a rule
 * scoped to `#foo*` is a pattern whose meaning would change if rewritten at all.
 *
 * Deciding what should happen there is a product question, not a mechanical one.
 * Until it's answered these are COUNTED and REPORTED rather than touched, so a
 * caller can surface "3 rules still mention the old name" instead of the rename
 * silently half-applying. rewriteChannelList below is the pure part, already
 * written and tested, for whoever picks this up.
 */
const UNHANDLED_TABLES: Readonly<Record<string, string>> = {
  highlight_rules: 'channel scope can span networks (junction; no rows = all)',
  ignored_masks: 'channel scope can be global (network_id NULL)',
};

/**
 * Tables whose move can't be expressed by a policy alone and have a named
 * function instead: `buffers` moves two columns in lockstep, `buffer_reads`
 * reconciles two progress values.
 */
const BESPOKE_HANDLERS = new Set(['buffers', 'buffer_reads']);

/**
 * Policies the generic dispatch below actually implements.
 *
 * Shared with `hasRenameHandler` so the coverage test can't drift from the code:
 * checking "is this table excused?" would be tautological, since the excuse list
 * is the same list. Checking the DECLARED POLICY against the set of implemented
 * ones is a real question — a new table declared `merge` fails the test rather
 * than throwing the first time someone renames a buffer in production.
 */
const IMPLEMENTED_POLICIES: ReadonlySet<string> = new Set(['rewrite', 'destination-wins']);

export interface RenameBufferResult {
  /** False when nothing anywhere referenced `from` — the rename was a no-op. */
  renamed: boolean;
  /** True when a buffer already existed at `to` and rows were merged into it. */
  merged: boolean;
  /** Per-table count of rows rewritten, merged, or dropped. */
  rowsAffected: Record<string, number>;
  /**
   * Rows in UNHANDLED_TABLES that still mention the old name. Non-empty means
   * the rename is complete for buffer state but some rule still points at the
   * old name — surface it, don't swallow it.
   */
  stillReferencing: Record<string, number>;
  /** The stored casing `from` resolved to. */
  resolvedFrom: string;
  /**
   * The name rows actually landed on. Differs from the caller's `to` when
   * merging into an existing buffer, whose stored casing wins — so this, not
   * the requested string, is what a client must be told to key by.
   */
  resolvedTo: string;
}

function tableExists(table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
}

/**
 * The casing this buffer is actually stored under.
 *
 * Callers hand us whatever the wire said — a NICK event's old nick, a RENAME's
 * old channel — whose casing needn't match what we stored. Every UPDATE below
 * then matches `target` EXACTLY, deliberately: `COLLATE NOCASE` or `lower()`
 * would defeat idx_messages_unread's (network_id, target) prefix and turn an
 * index range scan into a scan of every message on the network.
 *
 * So the folded lookup happens once, here, against the buffers registry — which
 * is the authority on display casing — and everything downstream is exact.
 *
 * A buffer with no registry row falls back to the caller's string as-is. So does
 * a genuine case fork in history: this renames ONE casing, and repairing a fork
 * is foldBufferCase's job, not this one's.
 */
function canonicalName(userId: number, networkId: number, target: string): string {
  return storedTarget(userId, networkId, target) ?? target;
}

/**
 * The registry's display casing for a folded target, read WITHOUT materializing
 * the record.
 *
 * Deliberately not `getBuffer`, which runs the row through `toRecord` and so
 * `decryptSecret` on the channel's +k envelope — and that THROWS for an envelope
 * sealed under a rotated or unknown key id. Renaming a keyed channel after a
 * LURKER_SECRET_KEY rotation would abort the whole rename on a crypto error, for
 * a key this function never looks at. Same reasoning as `getState` existing
 * alongside `getBuffer` in buffers.ts.
 */
function storedTarget(userId: number, networkId: number, target: string): string | undefined {
  const row = db
    .prepare(
      `SELECT target FROM buffers WHERE user_id = ? AND network_id = ? AND target_folded = ?`,
    )
    .get(userId, networkId, foldTarget(target)) as { target: string } | undefined;
  return row?.target;
}

function scopeSql(table: string, scope: readonly string[]): string {
  return (
    scope
      .filter((c) => c === 'user_id' || c === 'network_id')
      .map((c) => `${table}.${c} = ?`)
      .join(' AND ') || '1=1'
  );
}

function scopeArgs(scope: readonly string[], userId: number, networkId: number): number[] {
  return scope
    .filter((c) => c === 'user_id' || c === 'network_id')
    .map((c) => (c === 'user_id' ? userId : networkId));
}

/**
 * Rewrite one comma-separated channel-scope list.
 *
 * Only entries that are a LITERAL match for the old name are replaced. An entry
 * containing a glob metacharacter is left untouched: a rule scoped to `#old*`
 * expresses a pattern the user chose, and rewriting it to `#new*` would silently
 * change which channels it covers. A rule scoped to the literal `#old` clearly
 * meant this buffer, and should follow it.
 *
 * Lists are stored already normalized (trimmed, lowercased, deduped), so the
 * comparison is against the folded names and the replacement is written folded.
 */
export function rewriteChannelList(csv: string | null, from: string, to: string): string | null {
  if (!csv) return null;
  const fromFolded = foldTarget(from);
  const toFolded = foldTarget(to);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of csv.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const isGlob = /[*?]/.test(entry);
    const next = !isGlob && entry.toLowerCase() === fromFolded ? toFolded : entry;
    // Renaming onto a name the list already scopes would duplicate it.
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out.length ? out.join(',') : null;
}

/**
 * Rename `from` to `to` for one user on one network.
 *
 * Merges rather than refusing when `to` already exists — weechat declines the
 * rename in that case and leaves two buffers, which for a DM peer who reclaims
 * an old nick just strands history under a name they no longer use.
 *
 * A case-only rename (`#Foo` -> `#foo`) is a rewrite, not a merge: the folded
 * key is unchanged, so source and destination are the same row everywhere.
 */
export function renameBuffer(
  userId: number,
  networkId: number,
  from: string,
  to: string,
): RenameBufferResult {
  const resolvedFrom = canonicalName(userId, networkId, from);
  const rowsAffected: Record<string, number> = {};
  const stillReferencing: Record<string, number> = {};
  const empty: RenameBufferResult = {
    renamed: false,
    merged: false,
    rowsAffected,
    stillReferencing,
    resolvedFrom,
    resolvedTo: to,
  };

  if (!to || !resolvedFrom || resolvedFrom === to) return empty;

  const caseOnly = foldTarget(resolvedFrom) === foldTarget(to);
  // A destination row only counts as a collision when it's a DIFFERENT buffer.
  const destination = caseOnly ? undefined : storedTarget(userId, networkId, to);
  const merged = !!destination;

  // When merging, the DESTINATION's stored casing is what everything moves to —
  // not the caller's string.
  //
  // A NICK event is exactly this case: the wire says `Robert` while we already
  // hold a `robert` buffer. Writing rows as `Robert` while the surviving
  // registry row stays `robert` splits the buffer in half — the exact-match
  // backlog query finds only the rows that didn't move, `destination-wins`
  // quietly becomes "two rows", and mergeBufferReads' ON CONFLICT never fires so
  // the read pointers are never reconciled. Same invariant the fold now honours:
  // the registry owns display casing.
  const effectiveTo = destination ?? to;

  const run = db.transaction((): boolean => {
    let touched = false;
    const bump = (table: string, n: number) => {
      if (n > 0) {
        rowsAffected[table] = (rowsAffected[table] ?? 0) + n;
        touched = true;
      }
    };

    for (const t of BUFFER_KEYED_TABLES) {
      if (t.legacy || !tableExists(t.table)) continue;

      // Sentinel values that share the column but aren't buffer names
      // (e2e_autotrust's 'global'). Excluded from BOTH statements, so a DM peer
      // nicked `global` can't rewrite a network-wide rule.
      const guard = (t.excludeValues ?? []).map(() => `AND ${t.column} <> ?`).join(' ');
      const where = `${scopeSql(t.table, t.scope)} AND ${t.column} = ? ${guard}`;
      const args = [
        ...scopeArgs(t.scope, userId, networkId),
        resolvedFrom,
        ...(t.excludeValues ?? []),
      ];

      if (UNHANDLED_TABLES[t.table]) {
        const n = countListReferences(t, userId, resolvedFrom);
        if (n > 0) stillReferencing[t.table] = n;
        continue;
      }

      if (BESPOKE_HANDLERS.has(t.table)) {
        bump(
          t.table,
          t.table === 'buffers'
            ? renameBufferRow(userId, networkId, resolvedFrom, effectiveTo, caseOnly)
            : mergeBufferReads(userId, networkId, resolvedFrom, effectiveTo),
        );
        continue;
      }

      if (t.policy === 'rewrite') {
        // No uniqueness on the target, so every row moves and nothing collides.
        bump(
          t.table,
          db
            .prepare(`UPDATE ${t.table} SET ${t.column} = ? WHERE ${where}`)
            .run(effectiveTo, ...args).changes,
        );
        continue;
      }

      if (t.policy === 'destination-wins') {
        // OR IGNORE moves what it can; the DELETE clears what collided, leaving
        // the destination's own row as the survivor.
        const moved = db
          .prepare(`UPDATE OR IGNORE ${t.table} SET ${t.column} = ? WHERE ${where}`)
          .run(effectiveTo, ...args).changes;
        // `<> ? COLLATE BINARY` on the DELETE, not a caseOnly short-circuit.
        //
        // Four e2e tables declare their target column COLLATE NOCASE, so on a
        // case-only rename `WHERE channel = '#Foo'` still matches the row the
        // UPDATE just rewrote to '#foo' — and the DELETE destroys it. That
        // silently wiped every E2E session key for the channel. An explicit
        // BINARY comparison excludes rows already sitting at the destination
        // while still clearing genuine collision leftovers, which a caseOnly
        // short-circuit would strand.
        const dropped = db
          .prepare(`DELETE FROM ${t.table} WHERE ${where} AND ${t.column} <> ? COLLATE BINARY`)
          .run(...args, effectiveTo).changes;
        bump(t.table, moved + dropped);
        continue;
      }

      throw new Error(
        `renameBuffer: ${t.table} is declared policy '${t.policy}' with no handler. ` +
          `Add one, or correct its policy in bufferKeyedTables.ts.`,
      );
    }

    // Pins are dense per (user, network) and reorderPins assumes 0..n-1, so a
    // dropped collision has to be closed up. Cheap and idempotent, so it runs
    // whenever pins moved at all rather than only when one actually collided.
    if (rowsAffected.pinned_buffers) {
      db.prepare(
        `WITH renum AS (
           SELECT user_id, network_id, target,
                  ROW_NUMBER() OVER (
                    PARTITION BY user_id, network_id ORDER BY position ASC, target ASC
                  ) - 1 AS new_pos
             FROM pinned_buffers WHERE user_id = ? AND network_id = ?
         )
         UPDATE pinned_buffers SET position = (
           SELECT new_pos FROM renum
            WHERE renum.user_id = pinned_buffers.user_id
              AND renum.network_id = pinned_buffers.network_id
              AND renum.target = pinned_buffers.target
         )
         WHERE user_id = ? AND network_id = ?`,
      ).run(userId, networkId, userId, networkId);
    }

    return touched;
  });

  const renamed = run();
  return { renamed, merged, rowsAffected, stillReferencing, resolvedFrom, resolvedTo: effectiveTo };
}

/**
 * The registry row itself: `target` and its `target_folded` lookup key move
 * together, or the buffer becomes unfindable.
 *
 * On a merge the DESTINATION row survives, because it is the row already sitting
 * at the name everything will now ask for. What carries across from the source
 * is the state that would otherwise be lost: an open state (a rename shouldn't
 * resurrect history into a closed buffer, but it shouldn't hide it either), the
 * autojoin flag, a channel key, and the earlier created_at.
 */
function renameBufferRow(
  userId: number,
  networkId: number,
  from: string,
  to: string,
  caseOnly: boolean,
): number {
  // Raw row, not getBuffer: `toRecord` decrypts the +k envelope and throws for
  // one sealed under a rotated key id, which would abort a rename that never
  // reads the key. See storedTarget.
  const source = db
    .prepare(
      `SELECT state, autojoin, key, created_at AS createdAt FROM buffers
        WHERE user_id = ? AND network_id = ? AND target_folded = ?`,
    )
    .get(userId, networkId, foldTarget(from)) as
    | { state: string; autojoin: number; key: string | null; createdAt: string }
    | undefined;
  if (!source) return 0;

  if (caseOnly) {
    return db
      .prepare(
        `UPDATE buffers SET target = ?, target_folded = ?
          WHERE user_id = ? AND network_id = ? AND target_folded = ?`,
      )
      .run(to, foldTarget(to), userId, networkId, foldTarget(from)).changes;
  }

  const destination = storedTarget(userId, networkId, to);
  if (!destination) {
    return db
      .prepare(
        `UPDATE buffers SET target = ?, target_folded = ?
          WHERE user_id = ? AND network_id = ? AND target_folded = ?`,
      )
      .run(to, foldTarget(to), userId, networkId, foldTarget(from)).changes;
  }

  const merged = db
    .prepare(
      `UPDATE buffers
          SET state      = CASE WHEN ? = 'open' THEN 'open' ELSE state END,
              -- Paired with state, always: every other reopen path clears
              -- closed_at too (buffers.reopen), and leaving a stale timestamp on
              -- an open row is a contradiction the export/import round-trip
              -- branches on.
              closed_at  = CASE WHEN ? = 'open' THEN NULL ELSE closed_at END,
              autojoin   = MAX(autojoin, ?),
              key        = COALESCE(key, ?),
              created_at = MIN(created_at, ?)
        WHERE user_id = ? AND network_id = ? AND target_folded = ?`,
    )
    .run(
      source.state,
      source.state,
      source.autojoin ? 1 : 0,
      // Carry the stored envelope rather than a plaintext key — re-encrypting
      // would mean decrypting first, which is what we're avoiding. COALESCE
      // keeps the destination's own key when it has one, so this only fills a
      // gap.
      source.key,
      source.createdAt,
      userId,
      networkId,
      foldTarget(to),
    ).changes;

  const dropped = db
    .prepare(`DELETE FROM buffers WHERE user_id = ? AND network_id = ? AND target_folded = ?`)
    .run(userId, networkId, foldTarget(from)).changes;

  return merged + dropped;
}

/**
 * Read pointer and /clear marker — the one table where both sides carry progress
 * that has to be reconciled rather than picked between.
 *
 * Keeps the FURTHEST read pointer and the FURTHEST clear boundary independently,
 * so a merge can neither resurrect messages the user already read nor un-clear
 * ones they cleared. Same reasoning as foldBufferCase's merge; the shapes differ
 * because that one folds every fork at once and this one moves a single buffer.
 */
function mergeBufferReads(userId: number, networkId: number, from: string, to: string): number {
  const moved = db
    .prepare(
      `INSERT INTO buffer_reads
         (user_id, network_id, target, last_read_message_id, updated_at,
          cleared_before_message_id, cleared_at)
       SELECT user_id, network_id, ?, last_read_message_id, updated_at,
              cleared_before_message_id, cleared_at
         FROM buffer_reads
        WHERE user_id = ? AND network_id = ? AND target = ?
       ON CONFLICT(user_id, network_id, target) DO UPDATE SET
         last_read_message_id =
           MAX(buffer_reads.last_read_message_id, excluded.last_read_message_id),
         cleared_before_message_id = NULLIF(
           MAX(COALESCE(buffer_reads.cleared_before_message_id, 0),
               COALESCE(excluded.cleared_before_message_id, 0)), 0),
         cleared_at = CASE
           WHEN COALESCE(excluded.cleared_before_message_id, 0)
                > COALESCE(buffer_reads.cleared_before_message_id, 0)
           THEN excluded.cleared_at ELSE buffer_reads.cleared_at END,
         updated_at = MAX(buffer_reads.updated_at, excluded.updated_at)`,
    )
    .run(to, userId, networkId, from).changes;

  const dropped = db
    .prepare(`DELETE FROM buffer_reads WHERE user_id = ? AND network_id = ? AND target = ?`)
    .run(userId, networkId, from).changes;

  return moved + dropped;
}

/**
 * How many of this user's rules still name `from` literally.
 *
 * Scoped by user only — deliberately wider than the rename's own network scope,
 * because the point is to report everything the user might need to fix, and a
 * cross-network rule is exactly the case that can't be auto-rewritten.
 */
function countListReferences(
  t: (typeof BUFFER_KEYED_TABLES)[number],
  userId: number,
  from: string,
): number {
  const rows = db
    .prepare(`SELECT ${t.column} AS list FROM ${t.table} WHERE user_id = ?`)
    .all(userId) as Array<{ list: string | null }>;
  const fromFolded = foldTarget(from);
  return rows.filter((r) =>
    (r.list ?? '')
      .split(',')
      .some((e) => e.trim().toLowerCase() === fromFolded && !/[*?]/.test(e.trim())),
  ).length;
}

/** Registry tables with no handler here, and why. Asserted by the tests. */
export function unhandledRenameTables(): Readonly<Record<string, string>> {
  return UNHANDLED_TABLES;
}

/**
 * Whether a live registry entry is actually moved by renameBuffer.
 *
 * Mirrors the dispatch in the loop above via the same two constants, so this
 * answers "is there code that moves it" rather than "did someone remember to
 * excuse it".
 */
export function hasRenameHandler(table: string): boolean {
  const t = bufferKeyedTable(table);
  if (!t || t.legacy || UNHANDLED_TABLES[t.table]) return false;
  return BESPOKE_HANDLERS.has(t.table) || IMPLEMENTED_POLICIES.has(t.policy);
}
