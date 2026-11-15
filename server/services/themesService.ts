// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Saved theme presets (/api/themes). Validates writes against the settings
// registry (a theme is a snapshot of the `themed` keys, nothing else), enforces
// the name rules shared with the client, and emits 'change' so wsHub can tell
// the user's other devices to refresh their theme list — the same
// refetch-on-any-change contract highlightRulesService uses.

import { EventEmitter } from 'events';
import type { SettingValue } from '../../shared/settingsRegistry.js';
import {
  MAX_THEMES_PER_USER,
  THEME_POINTER_KEYS,
  normalizeThemeName,
  themeNameError,
} from '../../shared/themePresets.js';
import { validate, getOption } from './settingsRegistry.js';
import { withCurrentSettingKeys } from '../../shared/settingsRenames.js';
import type { ThemeRow } from '../db/themes.js';
import {
  listThemesForUser,
  getTheme,
  findThemeByName,
  countThemesForUser,
  createTheme,
  updateTheme,
  deleteTheme,
} from '../db/themes.js';
import { getUserSettings } from '../db/settings.js';
import settingsService from './settingsService.js';

type Result<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true } & T)
  | { ok: false; error: string; status?: number };

export { THEME_POINTER_KEYS };

// A theme's values must be a non-empty object of themed registry keys with
// type-valid values. A SUBSET of the themed keys is allowed on purpose: a key
// added to the registry after a theme was saved simply resolves to its registry
// default, so old themes survive registry growth without a migration.
function validateValues(
  raw: unknown,
): { ok: true; values: Record<string, SettingValue> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'values must be an object of { settingKey: value }' };
  }
  // A client from before a rename (shared/settingsRenames.ts) snapshots its
  // theme under the old keys; they land under the current ones.
  const entries = Object.entries(withCurrentSettingKeys(raw as Record<string, unknown>));
  if (!entries.length) return { ok: false, error: 'values must not be empty' };
  const values: Record<string, SettingValue> = {};
  for (const [key, value] of entries) {
    const opt = getOption(key);
    if (!opt || !opt.themed) return { ok: false, error: `${key} is not a themed setting` };
    const result = validate(key, value);
    if (!result.ok) return { ok: false, error: result.error };
    values[key] = result.value;
  }
  return { ok: true, values };
}

// '' when the name is usable, else the reason. Layered over the shared rules
// with the per-user uniqueness check (excluding the theme being renamed).
function nameError(userId: number, raw: string, excludeId?: number): string {
  const shared = themeNameError(raw);
  if (shared) return shared;
  const existing = findThemeByName(userId, normalizeThemeName(raw));
  if (existing && existing.id !== excludeId) {
    return `a theme named "${existing.name}" already exists`;
  }
  return '';
}

class ThemesService extends EventEmitter {
  list(userId: number): ThemeRow[] {
    return listThemesForUser(userId);
  }

  get(userId: number, id: number): ThemeRow | null {
    return getTheme(userId, id);
  }

  create(userId: number, raw: { name?: unknown; values?: unknown }): Result<{ theme: ThemeRow }> {
    if (typeof raw.name !== 'string') return { ok: false, error: 'name is required' };
    const err = nameError(userId, raw.name);
    if (err) return { ok: false, error: err };
    const checked = validateValues(raw.values);
    if (!checked.ok) return { ok: false, error: checked.error };
    if (countThemesForUser(userId) >= MAX_THEMES_PER_USER) {
      return { ok: false, error: `theme limit reached (${MAX_THEMES_PER_USER})` };
    }
    const theme = createTheme(userId, normalizeThemeName(raw.name), checked.values);
    this.emit('change', { userId });
    return { ok: true, theme };
  }

  update(
    userId: number,
    id: number,
    raw: { name?: unknown; values?: unknown },
  ): Result<{ theme: ThemeRow }> {
    const existing = getTheme(userId, id);
    if (!existing) return { ok: false, error: 'theme not found', status: 404 };
    const fields: { name?: string; values?: Record<string, SettingValue> } = {};
    if (raw.name !== undefined) {
      if (typeof raw.name !== 'string') return { ok: false, error: 'name must be a string' };
      const err = nameError(userId, raw.name, id);
      if (err) return { ok: false, error: err };
      fields.name = normalizeThemeName(raw.name);
    }
    if (raw.values !== undefined) {
      const checked = validateValues(raw.values);
      if (!checked.ok) return { ok: false, error: checked.error };
      fields.values = checked.values;
    }
    if (fields.name === undefined && fields.values === undefined) {
      return { ok: false, error: 'nothing to update: pass name and/or values' };
    }
    const theme = updateTheme(userId, id, fields)!;
    this.emit('change', { userId });
    return { ok: true, theme };
  }

  remove(userId: number, id: number): Result {
    if (!deleteTheme(userId, id)) return { ok: false, error: 'theme not found', status: 404 };
    // A pointer aimed at the deleted theme would dangle (the client resolver
    // falls back to Dark, but silently). Reset any such pointer to its default
    // here, server-authoritatively — one settings update, so every device gets
    // the same broadcast and re-themes in step with the deletion.
    const stored = getUserSettings(userId);
    // Exact-string match, matching how the client resolves pointers (byId over
    // ids minted as String(rowid)). A numeric compare here would call '012' a
    // pointer at theme 12 — a value no client ever renders as that theme.
    const dangling = THEME_POINTER_KEYS.filter((key) => stored[key] === String(id));
    if (dangling.length) settingsService.update(userId, {}, dangling);
    this.emit('change', { userId });
    return { ok: true };
  }
}

const themesService = new ThemesService();
export default themesService;
