// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type Database from 'better-sqlite3';

// Case-fold repair for forked buffers (#268 channels, #289/#327 generalization).
//
// IRC targets are case-insensitive, but some servers relay a different case than
// the one we joined/opened with (DALnet's registered #Christian vs the
// #christian we joined; a DM peer presented as `bob` vs the `Bob` we /query'd).
// Buffers used to key by exact case, so a stray case forked a second,
// metadata-less buffer with state split across the two casings. The live paths
// now fold case (canonicalChannelTarget server-side; the buffers store
// client-side), but already-forked rows linger in the DB across every
// target-keyed table.
//
// This is the one repair routine, shared by:
//   - the schema-version-9 one-shot migration (server/db/index.ts), scope 'all'
//     — merges every forked buffer (channels and DMs) when a DB upgrades past
//     v9; and
//   - the manual `tools/fold-buffer-case.ts` operator script — a re-runnable
//     fallback (scope 'all' by default, --channels-only to narrow) for forks
//     that appear after the migration already ran.
//
// Canonical case = the variant carrying the most messages (the buffer you
// actually used = the case you joined/opened with), ties broken by `target ASC`
// purely for determinism. A target that never drifted (a single case) maps to
// itself and is left untouched, so #idleRPG stays #idleRPG. The flat ':'-virtual
// buffers (`:server:`, `:friends:`…) are never folded. Composite-PK tables merge
// conflict-aware (furthest read pointer + clear marker, joined flag, junk-close
// dropped). The whole apply runs in one transaction; dryRun computes the same
// report without mutating.

// The schema version this fold was last audited against. The schema-version-9
// migration in index.ts calls foldBufferCase mid-upgrade (before the version row
// is written), so it can't be gated — but the manual operator script refuses to
// run unless the DB sits exactly here. A future migration that adds or reshapes
// a buffer-keyed table must re-check TARGET_TABLES (and the channels/buffer_reads
// merges) below, then deliberately bump this in lockstep with SCHEMA_VERSION in
// index.ts — so the script can never silently fold an out-of-date table set.
export const FOLD_VALIDATED_SCHEMA_VERSION = 9;

export type FoldScope = 'channels' | 'all';

export interface FoldVariant {
  target: string;
  messages: number;
}

export interface FoldGroup {
  networkId: number;
  // Lowercased target the variants share (the SQL `lower()` key).
  lkey: string;
  canonical: string;
  variants: FoldVariant[];
}

export interface FoldReport {
  scope: FoldScope;
  applied: boolean;
  // Per-table count of rows that were (or, in dryRun, would be) rewritten or
  // dropped — the authoritative "what changes". Keyed by table name. Empty when
  // the caller passed report:false (the migration), which skips its computation.
  rowsAffected: Record<string, number>;
  // Human-facing fork summary derived from message counts: each lkey that has
  // more than one message-cased variant, with the chosen canonical. A fork whose
  // stray case carries no messages (only e.g. a draft) still gets folded — it
  // shows in rowsAffected — but won't appear here, since groups are message-based.
  forks: FoldGroup[];
}

// Tables keyed by a per-buffer `target` column (channels live in `channels.name`,
// handled separately). Order matters only for readability; each fold is
// independent.
const TARGET_TABLES = [
  'messages',
  'input_history',
  'buffer_reads',
  'closed_buffers',
  'pinned_buffers',
  'nicklist_collapsed',
  'channel_notify_settings',
  'user_drafts',
] as const;

export function foldBufferCase(
  db: Database.Database,
  opts: { scope?: FoldScope; dryRun?: boolean; report?: boolean } = {},
): FoldReport {
  const scope: FoldScope = opts.scope ?? 'channels';
  const dryRun = opts.dryRun ?? false;
  // The migration discards the return, so it opts out (report:false) to skip the
  // two extra full `messages` scans the report costs — the per-table COUNTs and
  // the variant GROUP BY. The operator script keeps it (default true); it prints
  // the report in both dry-run and apply. The apply path needs only _buf_canon.
  const wantReport = opts.report ?? true;

  // Which targets the fold considers. 'channels' restricts to #-prefixed
  // channels; 'all' covers every real buffer — every channel prefix (#, &, +, !)
  // and DM nicks — while still excluding the ':'-virtual buffers.
  const pred = (col: string) => (scope === 'all' ? `${col} NOT LIKE ':%'` : `${col} LIKE '#%'`);

  // Resolves a row's canonical case from the temp table; matches only off-case
  // rows that have a canonical to fold into (so single-case targets and virtuals
  // are skipped). Table names are literals from TARGET_TABLES, never user input.
  const canonExpr = (t: string) =>
    `(SELECT c.canon FROM _buf_canon c
        WHERE c.network_id = ${t}.network_id AND c.lkey = lower(${t}.target))`;
  const needsFold = (t: string) =>
    `${pred(`${t}.target`)} AND EXISTS (SELECT 1 FROM _buf_canon c
        WHERE c.network_id = ${t}.network_id AND c.lkey = lower(${t}.target)
          AND c.canon <> ${t}.target)`;

  const work = (): FoldReport => {
    // Connection-local temp table; drop defensively in case a prior run in this
    // same connection left one behind.
    db.exec(`DROP TABLE IF EXISTS _buf_canon`);
    db.exec(`
      CREATE TEMP TABLE _buf_canon AS
      SELECT network_id, lower(target) AS lkey, target AS canon FROM (
        SELECT network_id, target,
               ROW_NUMBER() OVER (
                 PARTITION BY network_id, lower(target)
                 ORDER BY COUNT(*) DESC, target ASC
               ) AS rn
        FROM messages WHERE ${pred('target')}
        GROUP BY network_id, target
      ) WHERE rn = 1
    `);

    // ---- Report (computed pre-apply so counts reflect what will change).
    // Skipped entirely when the caller doesn't want it (the migration), since
    // these queries scan `messages` twice more on top of _buf_canon. ----
    const rowsAffected: Record<string, number> = {};
    let forks: FoldGroup[] = [];
    if (wantReport) {
      for (const t of TARGET_TABLES) {
        rowsAffected[t] = (
          db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${needsFold(t)}`).get() as { n: number }
        ).n;
      }
      rowsAffected['channels'] = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM channels
               WHERE ${pred('name')} AND EXISTS (
                 SELECT 1 FROM _buf_canon c
                 WHERE c.network_id = channels.network_id AND c.lkey = lower(channels.name)
                   AND c.canon <> channels.name)`,
          )
          .get() as { n: number }
      ).n;

      const variantRows = db
        .prepare(
          `SELECT m.network_id AS networkId, lower(m.target) AS lkey, m.target AS target,
                  COUNT(*) AS messages
             FROM messages m WHERE ${pred('m.target')}
             GROUP BY m.network_id, m.target`,
        )
        .all() as { networkId: number; lkey: string; target: string; messages: number }[];
      const canonByKey = new Map<string, string>();
      for (const r of db
        .prepare(`SELECT network_id AS networkId, lkey, canon FROM _buf_canon`)
        .all() as {
        networkId: number;
        lkey: string;
        canon: string;
      }[]) {
        canonByKey.set(`${r.networkId}::${r.lkey}`, r.canon);
      }
      const grouped = new Map<string, FoldGroup>();
      for (const r of variantRows) {
        const k = `${r.networkId}::${r.lkey}`;
        let g = grouped.get(k);
        if (!g) {
          g = {
            networkId: r.networkId,
            lkey: r.lkey,
            canonical: canonByKey.get(k) ?? r.target,
            variants: [],
          };
          grouped.set(k, g);
        }
        g.variants.push({ target: r.target, messages: r.messages });
      }
      forks = [...grouped.values()].filter((g) => g.variants.length > 1);
    }

    if (!dryRun) {
      // id-keyed (target not unique) — straight rewrite. messages_fts only indexes
      // text, so the AFTER UPDATE trigger reindexes identical text (harmless).
      for (const t of ['messages', 'input_history']) {
        db.exec(`UPDATE ${t} SET target = ${canonExpr(t)} WHERE ${needsFold(t)}`);
      }

      // channels: UNIQUE(network_id, name). Fold to canon (joined if ANY variant
      // was joined, earliest created_at, and any +k key from either side), then
      // drop the off-case variant. Carrying `key` here is essential — without it
      // the merge would strip the channel key off a case-forked keyed channel
      // and it would fail to auto-rejoin after the next reconnect.
      db.exec(`
        INSERT INTO channels (network_id, name, joined, created_at, key)
          SELECT ch.network_id, c.canon, ch.joined, ch.created_at, ch.key
          FROM channels ch JOIN _buf_canon c
            ON c.network_id = ch.network_id AND c.lkey = lower(ch.name)
          WHERE ${pred('ch.name')} AND c.canon <> ch.name
        ON CONFLICT(network_id, name) DO UPDATE SET
          joined = MAX(channels.joined, excluded.joined),
          created_at = MIN(channels.created_at, excluded.created_at),
          key = COALESCE(channels.key, excluded.key)
      `);
      db.exec(`
        DELETE FROM channels WHERE ${pred('name')} AND EXISTS (
          SELECT 1 FROM _buf_canon c
          WHERE c.network_id = channels.network_id AND c.lkey = lower(channels.name)
            AND c.canon <> channels.name)
      `);

      // buffer_reads: composite PK. Merge keeping the furthest read pointer and any
      // clear marker, then drop the variant so nothing resurfaces as unread.
      db.exec(`
        INSERT INTO buffer_reads
          (user_id, network_id, target, last_read_message_id, updated_at,
           cleared_before_message_id, cleared_at)
          SELECT br.user_id, br.network_id, c.canon, br.last_read_message_id, br.updated_at,
                 br.cleared_before_message_id, br.cleared_at
          FROM buffer_reads br JOIN _buf_canon c
            ON c.network_id = br.network_id AND c.lkey = lower(br.target)
          WHERE ${pred('br.target')} AND c.canon <> br.target
        ON CONFLICT(user_id, network_id, target) DO UPDATE SET
          last_read_message_id =
            MAX(buffer_reads.last_read_message_id, excluded.last_read_message_id),
          -- Keep the *furthest* /clear boundary (and its matching cleared_at) so
          -- folding can't un-clear messages the user cleared in the other variant.
          -- NULLIF restores NULL when neither row had a marker.
          cleared_before_message_id = NULLIF(
            MAX(COALESCE(buffer_reads.cleared_before_message_id, 0),
                COALESCE(excluded.cleared_before_message_id, 0)), 0),
          cleared_at = CASE
            WHEN COALESCE(excluded.cleared_before_message_id, 0)
                 > COALESCE(buffer_reads.cleared_before_message_id, 0)
            THEN excluded.cleared_at ELSE buffer_reads.cleared_at END,
          updated_at = MAX(buffer_reads.updated_at, excluded.updated_at)
      `);
      db.exec(`DELETE FROM buffer_reads WHERE ${needsFold('buffer_reads')}`);

      // closed_buffers: a stray-cased row was the junk buffer the user closed; the
      // canonical buffer's own open/closed state wins, so drop the off-case rows.
      db.exec(`DELETE FROM closed_buffers WHERE ${needsFold('closed_buffers')}`);

      // Remaining per-(user, network, target) state: move to canon, or drop if a
      // canon row already exists (its state wins).
      for (const t of [
        'pinned_buffers',
        'nicklist_collapsed',
        'channel_notify_settings',
        'user_drafts',
      ]) {
        db.exec(`UPDATE OR IGNORE ${t} SET target = ${canonExpr(t)} WHERE ${needsFold(t)}`);
        db.exec(`DELETE FROM ${t} WHERE ${needsFold(t)}`);
      }

      // Keep pin positions dense per (user, network): a dropped duplicate pin can
      // leave a gap, and reorderPins assumes 0..n-1 (same fix as schemaVersion 7).
      db.exec(`
        WITH renum AS (
          SELECT user_id, network_id, target,
                 ROW_NUMBER() OVER (
                   PARTITION BY user_id, network_id ORDER BY position ASC, target ASC
                 ) - 1 AS new_pos
          FROM pinned_buffers
        )
        UPDATE pinned_buffers SET position = (
          SELECT new_pos FROM renum
          WHERE renum.user_id = pinned_buffers.user_id
            AND renum.network_id = pinned_buffers.network_id
            AND renum.target = pinned_buffers.target
        )
      `);
    }

    db.exec(`DROP TABLE _buf_canon`);
    return { scope, applied: !dryRun, rowsAffected, forks };
  };

  // dryRun only reads (plus a connection-local temp table), so it runs outside a
  // transaction; apply wraps the whole rewrite in one so a failure can't leave a
  // half-folded buffer.
  return dryRun ? work() : db.transaction(work)();
}
