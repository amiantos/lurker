// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Settings whose key or stored value was renamed, old → new. One table, read
// by the schema migration that rewrites an install (server/db/index.ts) and by
// import, which meets the old names in an archive from before it.
//
// The message layouts were "standard" and "compact" until they were named
// Traditional and Modern (schema v28); every key and value that said so moved
// with them.

export const RENAMED_SETTING_KEYS: Readonly<Record<string, string>> = {
  'look.message.compact.group_gap': 'look.message.modern.group_gap',
  'look.message.compact.line_height': 'look.message.modern.line_height',
  'look.message.compact.indent': 'look.message.modern.indent',
  'look.buffer.time_format_compact': 'look.buffer.time_format_modern',
  'look.buffer.date_format_compact': 'look.buffer.date_format_modern',
};

/** The key a setting is stored under now; any other key comes back as it is. */
export function currentSettingKey(key: string): string {
  return Object.prototype.hasOwnProperty.call(RENAMED_SETTING_KEYS, key)
    ? RENAMED_SETTING_KEYS[key]
    : key;
}

/** A saved theme's values (or any key → value map) under the current keys. */
export function withCurrentSettingKeys<T>(values: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  // Old names first, so a map that somehow holds both ends on the new one's value.
  for (const [key, value] of Object.entries(values)) {
    if (currentSettingKey(key) !== key) out[currentSettingKey(key)] = value;
  }
  for (const [key, value] of Object.entries(values)) {
    if (currentSettingKey(key) === key) out[key] = value;
  }
  return out;
}

export const LAYOUT_SETTING_KEY = 'look.message.layout';

/**
 * look.message.layout's value as it is spelled now, or null for one that no
 * longer exists and falls to the default: `auto` was the grid on a desktop and
 * the two-line layout on a phone, which is what Traditional is, and `standard`
 * forced the grid onto phones, which nothing does.
 */
export function currentLayoutValue(value: unknown): string | null {
  if (value === 'compact' || value === 'modern') return 'modern';
  return null;
}
