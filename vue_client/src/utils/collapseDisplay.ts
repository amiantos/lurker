// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-row display-collapsing pass. Runs after consolidateRows over the same
// row shape MessageList emits — items either have `m` for a real row, a
// `divider` field, or `consolidation: true`. Mutates rows in place (they're
// freshly built each renderRows tick) to tag:
//
//   continuationAuthor: true  — suppress the nick prefix on this row because
//                               the previous visible row was a plain message
//                               (or, with collapseNotices, a notice) of the
//                               same type from the same author within the
//                               gap window.
//
//   continuationTime: true    — suppress the timestamp on this row because
//                               the previous visible row displayed the same
//                               formatted time string.
//
// Only `type === 'message'` participates in author collapsing, plus notices
// when `collapseNotices` is set (the compact layout, #1180). In the standard
// layout a notice's `-nick-` prefix belongs to its line, as an action's `*`
// does, so collapsing it would break the visual identity; keep them as
// anchors. The compact head carries the nick for a notice as it does for a
// message, so there a bot's run of notices groups under one head. The type is
// part of the run's identity: a notice never continues a message run or the
// reverse (the apps' MessageGrouping rule — NOTICE means "don't reply to
// this", and one head over both would erase the distinction the sender
// chose). Actions name their own actor and stay anchors everywhere. System
// events (join/part/etc.) and consolidation summary rows break the author run.
//
// Time collapsing applies to every row that displays a time (chat rows,
// system rows, consolidation rows). Dividers carry no time and reset both
// chains so the marker stands alone.

export interface MessageRowInner {
  id?: number | string;
  type?: string;
  nick?: string;
  time?: string;
  self?: boolean;
  // A re-attributed relay line (#277): the bot that said it and where the
  // speaker is from. Part of the author's identity for run collapsing.
  relayBot?: string | null;
  relaySource?: string | null;
}

export interface DisplayRow {
  // One of: m (chat row), consolidation (summary row), divider (marker)
  m?: MessageRowInner;
  consolidation?: boolean;
  divider?: string | boolean;
  time?: string;
  key?: string | number;
  // Mutated by this pass:
  continuationAuthor?: boolean;
  continuationTime?: boolean;
}

export interface CollapseOptions {
  collapseAuthors?: boolean;
  // Notices collapse into runs of their own kind too (compact layout only).
  collapseNotices?: boolean;
  collapseTimestamps?: boolean;
  formatTime?: (iso: string | undefined) => string;
  authorWindowMs?: number;
}

export function collapseDisplay(rows: DisplayRow[], options: CollapseOptions = {}): DisplayRow[] {
  const collapseAuthors = !!options.collapseAuthors;
  const collapseNotices = collapseAuthors && !!options.collapseNotices;
  const collapseTimestamps = !!options.collapseTimestamps;
  if (!collapseAuthors && !collapseTimestamps) return rows;

  const formatTime = options.formatTime || ((): string => '');
  const authorWindowMs = Math.max(0, options.authorWindowMs ?? 0);

  let prevAuthorKey: string | null = null;
  let prevAuthorTimeMs: number | null = null;
  let prevTimeStr: string | null = null;
  let prevTimeSeen = false;

  for (const row of rows) {
    if (row.divider) {
      prevAuthorKey = null;
      prevAuthorTimeMs = null;
      prevTimeStr = null;
      prevTimeSeen = false;
      continue;
    }

    const iso = row.consolidation ? row.time : row.m?.time;
    const timeMs = iso ? Date.parse(iso) || 0 : 0;
    const timeStr = collapseTimestamps ? formatTime(iso) : '';

    const type = row.consolidation ? undefined : row.m?.type;
    if (
      collapseAuthors &&
      row.m &&
      (type === 'message' || (collapseNotices && type === 'notice'))
    ) {
      // Self flag is part of the visual identity (self color vs. nick color),
      // so a self message after a non-self message from the same nick must
      // not collapse — even though that's a deeply unusual case. So is where a
      // relayed speaker is from: a bridged `alice` is not the local `alice`,
      // and anyone on a bridged platform can pick an IRC regular's nick —
      // folding them into one run is misattribution, not polish (the iOS
      // port's MessageGrouping.sameAuthor folds on the same three). And so is
      // the type: a notice and a message from one nick are two runs. Nick
      // case is not: servers send a nick inconsistently cased, the colour
      // hash folds it, and so do the apps and the reply-quote run check.
      const key = `${type}:${row.m.self ? '1' : '0'}:${(row.m.nick || '').toLowerCase()}:${row.m.relayBot || ''}:${row.m.relaySource || ''}`;
      // The delta must be non-negative: rows carry server-time, which a
      // bouncer replay can stamp OLDER than the preceding row's. A negative
      // delta would trivially pass the window check and collapse a replayed
      // old line under a fresh message it doesn't belong to.
      const deltaMs = prevAuthorTimeMs != null ? timeMs - prevAuthorTimeMs : -1;
      if (prevAuthorKey === key && deltaMs >= 0 && deltaMs <= authorWindowMs) {
        row.continuationAuthor = true;
      }
      prevAuthorKey = key;
      prevAuthorTimeMs = timeMs;
    } else {
      prevAuthorKey = null;
      prevAuthorTimeMs = null;
    }

    if (collapseTimestamps) {
      if (prevTimeSeen && prevTimeStr === timeStr && timeStr !== '') {
        row.continuationTime = true;
      }
      prevTimeStr = timeStr;
      prevTimeSeen = true;
    }
  }

  return rows;
}
