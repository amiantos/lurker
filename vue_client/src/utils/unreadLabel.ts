// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Keep an unread/highlight count narrow wherever it's shown — a four-figure
// number would stretch the row or control it sits on. Past 999 it is shortened
// (1.2k, 12k, 1.2m) rather than capped: the server sends the whole count
// (#1436). Rounded DOWN, so a badge never claims a line that isn't there.
// Shared by BufferList's per-row badges and the collapsed-list highlight chip
// (useHighlightChip) so both shorten by one rule, not two copies.
export function unreadLabel(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return short(count / 1000) + 'k';
  return short(count / 1_000_000) + 'm';
}

// One decimal below ten ("1.2"), none from ten up ("12") or when it is zero ("1").
function short(n: number): string {
  if (n >= 10) return String(Math.floor(n));
  return String(Math.floor(n * 10) / 10);
}
