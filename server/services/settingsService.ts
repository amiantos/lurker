// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import type { SettingValue } from '../../shared/settingsRegistry.js';
import { currentSettingKey, currentSettingWrite } from '../../shared/settingsRenames.js';
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

// One setting, read once per user and kept until their settings change: for
// paths that ask per event (the IRC insert path, a connect snapshot's
// per-buffer unread counts) where effectiveSetting's table read per call adds
// up. Cleared by the service's own writes below; a write made behind the
// service (an import replaces user_settings directly) is covered by the hub
// clearing it at every snapshot (forgetCachedSettings).
const cached = new Map<number, Map<string, SettingValue | undefined>>();

export function cachedSetting(userId: number, key: string): SettingValue | undefined {
  let mine = cached.get(userId);
  if (!mine) {
    mine = new Map();
    cached.set(userId, mine);
  }
  if (!mine.has(key)) mine.set(key, effectiveSetting(userId, key));
  return mine.get(key);
}

export function forgetCachedSettings(userId: number): void {
  cached.delete(userId);
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

// The keys among `keys` the user has changed: stored, and different from the
// registry default. update() drops a row set back to its default, so a default
// stored some other way (an import, say) isn't a change either. Unknown keys
// never are.
export function changedSettings(userId: number, keys: readonly string[]): Set<string> {
  const stored = getUserSettings(userId);
  const out = new Set<string>();
  for (const key of keys) {
    const opt = getOption(key);
    if (!opt || !Object.prototype.hasOwnProperty.call(stored, key)) continue;
    if (!valuesEqual(stored[key] as SettingValue, opt.default)) out.add(key);
  }
  return out;
}

class SettingsService extends EventEmitter {
  // changes: { [key]: rawValue }; resets: keys to delete outright (theme apply
  // clears every themed override alongside its pointer write, atomically).
  // Returns { ok: true, values } on full success or { ok: false, error, key } on
  // the first invalid entry — nothing is written on a validation failure.
  //
  // The emitted event carries both shapes: `changes` includes a { key: default }
  // entry for every deleted key (the pre-resets frame older clients understand),
  // and `resets` names the deleted keys explicitly. The web client applies
  // changes then resets, so for a themed key the two are distinguishable:
  // "override equal to the registry default" stays an override, "reset" removes
  // the row. Under a non-default theme those render differently.
  update(
    userId: number,
    changes: Record<string, unknown>,
    resets: string[] = [],
  ): { ok: false; error: string; key: string } | { ok: true; values: Record<string, unknown> } {
    // A client from before a rename (shared/settingsRenames.ts) still writes
    // the old key or value; it lands under the current one.
    resets = resets.map(currentSettingKey);
    const validated: Record<string, SettingValue> = {};
    for (const [sentKey, sent] of Object.entries(changes)) {
      const [key, raw] = currentSettingWrite(sentKey, sent);
      const result = validate(key, raw);
      if (!result.ok) return { ok: false, error: result.error, key: sentKey };
      validated[key] = result.value;
    }
    for (const key of resets) {
      if (!getOption(key)) return { ok: false, error: `unknown setting: ${key}`, key };
    }
    const deleted = new Set<string>();
    for (const key of resets) {
      deleteUserSetting(userId, key);
      deleted.add(key);
    }
    for (const [key, value] of Object.entries(validated)) {
      const opt = getOption(key);
      // Setting a key back to its default is semantically "no override"; drop
      // the row so isModified() reflects that everywhere. EXCEPT themed keys:
      // their fallback is the active theme, not the registry default, so on a
      // non-default theme "set it to the default color" is a real override —
      // dropping it would silently re-theme the value (a default is not a
      // statement). Themed rows only leave via an explicit reset.
      if (opt && !opt.themed && valuesEqual(value, opt.default)) {
        deleteUserSetting(userId, key);
        deleted.add(key);
      } else {
        setUserSetting(userId, key, value);
        deleted.delete(key);
      }
    }
    if (Object.keys(validated).length > 0 || deleted.size > 0) {
      forgetCachedSettings(userId);
      const eventChanges: Record<string, SettingValue> = { ...validated };
      for (const key of deleted) eventChanges[key] = getOption(key)!.default;
      this.emit('event', { userId, changes: eventChanges, resets: [...deleted] });
    }
    return { ok: true, values: getUserSettings(userId) };
  }

  reset(
    userId: number,
    key: string,
  ): { ok: false; error: string } | { ok: true; values: Record<string, unknown> } {
    key = currentSettingKey(key);
    const opt = getOption(key);
    if (!opt) return { ok: false, error: `unknown setting: ${key}` };
    deleteUserSetting(userId, key);
    forgetCachedSettings(userId);
    this.emit('event', { userId, changes: { [key]: opt.default }, resets: [key] });
    return { ok: true, values: getUserSettings(userId) };
  }
}

const settingsService = new SettingsService();
export default settingsService;
