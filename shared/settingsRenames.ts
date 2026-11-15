// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Settings whose key or stored value was renamed, old → new. One table, read
// by the schema migration that rewrites an install (server/db/index.ts), by
// import, which meets the old names in an archive from before it, and by the
// settings write path, which meets them from a client built before it.
//
// The message layouts were "standard" and "compact" until they were named
// Traditional and Modern (schema v28); every key and value that said so moved
// with them.

import { currentAvatarSetId } from './avatarTiles.js';

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
  if (value === 'traditional') return 'traditional';
  return null;
}

const AVATAR_SET_SETTING_KEY = 'look.avatars.set';

/**
 * A write from a client built before the rename, as the write it is now: the
 * key under its current name, and for the two settings whose values were
 * respelled, the value too. An old tab or app build keeps working against an
 * upgraded server for as long as it is open. Anything current passes through.
 */
export function currentSettingWrite(key: string, value: unknown): [string, unknown] {
  const now = currentSettingKey(key);
  if (now === LAYOUT_SETTING_KEY && (value === 'auto' || value === 'standard')) {
    return [now, 'traditional'];
  }
  if (now === LAYOUT_SETTING_KEY && value === 'compact') return [now, 'modern'];
  if (now === AVATAR_SET_SETTING_KEY && typeof value === 'string') {
    return [now, currentAvatarSetId(value)];
  }
  return [now, value];
}
