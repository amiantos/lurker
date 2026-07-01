// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type Database from 'better-sqlite3';
import { canonicalizeLevels } from '../../shared/ignoreLevels.js';

// The mute rung's levels, serialized in canonical order — derived (not a literal)
// so it can't drift from what the GUI/parser store, keeping the dedupe guard and
// the two write paths byte-identical.
const MUTE_CSV = canonicalizeLevels(['NOUNREAD', 'NONOTIFY']).join(',');

// Issue #359: fold the deprecated per-channel display-only `muted` flag into the
// ignore engine. A muted channel becomes a network-scoped NOUNREAD+NONOTIFY rule
// (mute now also silences notifications, matching Discord/The Lounge). Called at
// DB init, after the ignored_masks table is in its final shape.
//
// A row that ALSO had notify_always=1 is a pre-#359 contradiction ("push every
// message" + a display-only badge hide). notify_always is the explicit opt-in to
// notifications, so we preserve it and do NOT create a suppressor rule for those
// rows — only drop the deprecated muted bit. A silent NONOTIFY there would freeze
// the push the user explicitly asked for.
//
// Idempotent and self-gating: converting a row clears/deletes it, so a re-run
// finds nothing — no schema_version needed, and it self-heals a half-migrated DB.
// Returns the number of muted rows processed.
export function foldMutedIntoIgnoreRules(db: Database.Database): number {
  const mutedRows = db
    .prepare(
      `SELECT user_id AS userId, network_id AS networkId, target, notify_always AS notifyAlways
       FROM channel_notify_settings WHERE muted = 1`,
    )
    .all() as Array<{ userId: number; networkId: number; target: string; notifyAlways: number }>;
  if (!mutedRows.length) return 0;

  const findRule = db.prepare(
    `SELECT id FROM ignored_masks
     WHERE user_id = @userId AND network_id = @networkId AND mask IS NULL
       AND channels = @channels AND pattern IS NULL AND is_except = 0
       AND levels = @levels`,
  );
  const insertRule = db.prepare(
    `INSERT INTO ignored_masks (user_id, network_id, mask, channels, pattern, pattern_kind, levels, is_except)
     VALUES (@userId, @networkId, NULL, @channels, NULL, 'substr', @levels, 0)`,
  );
  const clearMuted = db.prepare(
    `UPDATE channel_notify_settings SET muted = 0
     WHERE user_id = @userId AND network_id = @networkId AND target = @target`,
  );
  const dropRow = db.prepare(
    `DELETE FROM channel_notify_settings
     WHERE user_id = @userId AND network_id = @networkId AND target = @target`,
  );

  const migrate = db.transaction(
    (rows: Array<{ userId: number; networkId: number; target: string; notifyAlways: number }>) => {
      for (const row of rows) {
        const rowKey = { userId: row.userId, networkId: row.networkId, target: row.target };
        if (row.notifyAlways) {
          // Preserve the explicit always-notify choice; just drop the deprecated
          // muted bit, keeping the row.
          clearMuted.run(rowKey);
          continue;
        }
        // Pure mute → a network-scoped NOUNREAD+NONOTIFY rule, then drop the now-
        // empty settings row. Ignore channels are stored lowercased; match the
        // GUI/parser so a later GUI toggle dedupes onto the same rule.
        const ruleParams = {
          userId: row.userId,
          networkId: row.networkId,
          channels: row.target.toLowerCase(),
          levels: MUTE_CSV,
        };
        if (!findRule.get(ruleParams)) insertRule.run(ruleParams);
        dropRow.run(rowKey);
      }
    },
  );
  migrate(mutedRows);
  return mutedRows.length;
}
