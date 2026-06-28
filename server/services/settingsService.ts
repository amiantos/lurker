// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import type { SettingValue } from '../../shared/settingsRegistry.js';
import { validate, getOption } from './settingsRegistry.js';
import { setUserSetting, deleteUserSetting, getUserSettings } from '../db/settings.js';

// Resolve a single setting's effective value for a user: their stored override,
// or the registry default. For code paths outside the request cycle (e.g. the
// IRC quit reason) that have no client-supplied value to fall back on. Unknown
// keys return undefined; the own-property check avoids treating inherited
// names (toString, etc.) as overrides.
export function effectiveSetting(userId: number, key: string): SettingValue | undefined {
  const opt = getOption(key);
  if (!opt) return undefined;
  const stored = getUserSettings(userId);
  if (Object.prototype.hasOwnProperty.call(stored, key)) return stored[key] as SettingValue;
  return opt.default;
}

// Resolve several settings in ONE getUserSettings() read, for hot paths that
// need a cluster of related settings (e.g. the CTCP auto-reply config) without
// firing a full-table load per key. Same stored-override-or-registry-default
// rule as effectiveSetting; unknown keys map to undefined.
export function effectiveSettings(
  userId: number,
  keys: string[],
): Record<string, SettingValue | undefined> {
  const stored = getUserSettings(userId);
  const out: Record<string, SettingValue | undefined> = {};
  for (const key of keys) {
    const opt = getOption(key);
    if (!opt) {
      out[key] = undefined;
    } else if (Object.prototype.hasOwnProperty.call(stored, key)) {
      out[key] = stored[key] as SettingValue;
    } else {
      out[key] = opt.default;
    }
  }
  return out;
}

function valuesEqual(a: SettingValue, b: SettingValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}

class SettingsService extends EventEmitter {
  // changes: { [key]: rawValue }
  // Returns { ok: true, values } on full success or { ok: false, error, key } on first invalid entry.
  update(
    userId: number,
    changes: Record<string, unknown>,
  ): { ok: false; error: string; key: string } | { ok: true; values: Record<string, unknown> } {
    const validated: Record<string, SettingValue> = {};
    for (const [key, raw] of Object.entries(changes)) {
      const result = validate(key, raw);
      if (!result.ok) return { ok: false, error: result.error, key };
      validated[key] = result.value;
    }
    for (const [key, value] of Object.entries(validated)) {
      const opt = getOption(key);
      // Setting a key back to its default is semantically "no override";
      // drop the row so isModified() reflects that everywhere.
      if (opt && valuesEqual(value, opt.default)) {
        deleteUserSetting(userId, key);
      } else {
        setUserSetting(userId, key, value);
      }
    }
    if (Object.keys(validated).length > 0) {
      this.emit('event', { userId, changes: validated });
    }
    return { ok: true, values: getUserSettings(userId) };
  }

  reset(
    userId: number,
    key: string,
  ): { ok: false; error: string } | { ok: true; values: Record<string, unknown> } {
    const opt = getOption(key);
    if (!opt) return { ok: false, error: `unknown setting: ${key}` };
    deleteUserSetting(userId, key);
    this.emit('event', { userId, changes: { [key]: opt.default } });
    return { ok: true, values: getUserSettings(userId) };
  }
}

const settingsService = new SettingsService();
export default settingsService;
