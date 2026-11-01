// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// SQLite's datetime('now') is 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker.
// Put it on the wire as ISO 8601 so a reader needs to know nothing about the
// store. Null stays null, and so does a value that is not a datetime at all: a
// corrupt row must never masquerade as a time.
export function sqliteUtcToIso(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const iso = stored.replace(' ', 'T') + 'Z';
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}
