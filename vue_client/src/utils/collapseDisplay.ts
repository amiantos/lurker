// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-row display-collapsing pass. Runs after consolidateRows over the same
// row shape MessageList emits — items either have `m` for a real row, a
// `divider` field, or `consolidation: true`. Mutates rows in place (they're
// freshly built each renderRows tick) to tag:
//
//   continuationAuthor: true  — suppress the nick prefix on this row because
//                               the previous visible row was a plain message
//                               from the same author within the gap window.
//
//   continuationTime: true    — suppress the timestamp on this row because
//                               the previous visible row displayed the same
//                               formatted time string.
//
// Only `type === 'message'` participates in author collapsing. Actions and
// notices have a distinct prefix shape (`*` / `-nick-`) and embed the nick
// into the body text, so collapsing them would either break visual identity
// or require body-string surgery; keep them as anchors. System events
// (join/part/etc.) and consolidation summary rows break the author run.
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
  collapseTimestamps?: boolean;
  formatTime?: (iso: string | undefined) => string;
  authorWindowMs?: number;
}

export function collapseDisplay(rows: DisplayRow[], options: CollapseOptions = {}): DisplayRow[] {
  const collapseAuthors = !!options.collapseAuthors;
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

    if (collapseAuthors && !row.consolidation && row.m?.type === 'message') {
      // Self flag is part of the visual identity (self color vs. nick color),
      // so a self message after a non-self message from the same nick must
      // not collapse — even though that's a deeply unusual case.
      const key = `${row.m.self ? '1' : '0'}:${row.m.nick || ''}`;
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
