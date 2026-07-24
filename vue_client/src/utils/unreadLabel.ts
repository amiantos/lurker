// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Keep an unread/highlight count narrow wherever it's shown — a four-figure
// number would stretch the row or control it sits on and isn't more actionable
// than "a lot". Shared by BufferList's per-row badges and the collapsed-list
// highlight chip (useHighlightChip) so both cap by one rule, not two copies.
export function unreadLabel(count: number): string {
  return count > 999 ? '>999' : String(count);
}
