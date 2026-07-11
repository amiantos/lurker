// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Instance-level key/value settings (issue #510). A tiny surface — one key today
// (uploads.allow_user_defined) — distinct from per-user settings: these belong to
// the whole instance, set by the admin/operator, not scoped to any account.

import db from './index.js';
import { isNodeMode } from '../utils/edition.js';

export function getInstanceSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM instance_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setInstanceSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO instance_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// Keep this literal in sync with the one the seed migration writes
// (db/uploaderConfigSeed.ts) — the seed can't import this module (import cycle),
// so the string lives in both places by necessity.
export const ALLOW_USER_DEFINED_KEY = 'uploads.allow_user_defined';

/**
 * May users define their own uploaders? Default when unset: yes on self-host
 * (trusted), no on the hosted fleet (tenants get the operator's locked default).
 */
export function allowUserDefinedUploaders(): boolean {
  const v = getInstanceSetting(ALLOW_USER_DEFINED_KEY);
  if (v === null) return !isNodeMode();
  return v === '1';
}

export function setAllowUserDefinedUploaders(allow: boolean): void {
  setInstanceSetting(ALLOW_USER_DEFINED_KEY, allow ? '1' : '0');
}
