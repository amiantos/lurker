// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Built-in theme presets and the naming rules for saved ones. Shared like the
// settings registry: the client resolves themed keys against these, the server
// validates /api/themes writes against them.
//
// A theme is a snapshot of the `themed` registry keys (shared/settingsRegistry
// THEMED_KEYS). Built-ins are code, not rows: Dark IS the registry defaults
// (computed on demand so a default change never needs a data migration), and
// Light overrides only the literal colors — keys whose default is a var()
// reference (link, self nick, the buffer list's colours, alt row bg) keep the
// reference so they track whichever palette is active.
//
// The mIRC palette is NOT among them: all sixteen slots are literals in both
// presets. A colour code names a colour, and a slot that defers to the theme
// breaks the moment a sender pairs it with a background of their own. See the
// ⚠ on look.color.mirc_colors.

import type { SettingValue } from './settingsRegistry.js';
import { themedDefaults } from './settingsRegistry.js';

export interface ThemePreset {
  /** 'dark' / 'light' for built-ins; the decimal user_themes row id for saved themes. */
  id: string;
  name: string;
  builtin: boolean;
  values: Record<string, SettingValue>;
}

// Name rules for saved themes, enforced in the client and re-validated by the
// server. Reserved names cover the built-ins' display names ("Monokai Plus" /
// "Monokai Plus Light" — named for what they are: the Monokai Pro palette,
// plus Lurker's extended hues), their ids ('dark'/'light', which double as
// /theme aliases), and 'default' (what the theme-editor spec called the
// registry-defaults theme before it grew a light sibling).
export const THEME_NAME_MAX = 40;
export const RESERVED_THEME_NAMES: readonly string[] = Object.freeze([
  'default',
  'dark',
  'light',
  'monokai plus',
  'monokai plus light',
]);
export const MAX_THEMES_PER_USER = 50;

// The three settings whose stored value is a theme id. look.theme.mode is a
// mode switch, not a pointer, so it never dangles. Shared because three
// resolvers care: the client resolver, the server's delete-time pointer reset,
// and the import-time pointer rewrite.
export const THEME_POINTER_KEYS: readonly string[] = Object.freeze([
  'look.theme.active',
  'look.theme.light',
  'look.theme.dark',
]);

export function normalizeThemeName(raw: string): string {
  return raw.trim();
}

/**
 * Case-fold for theme-name comparisons. ASCII-only ON PURPOSE: the server's
 * uniqueness domain is SQLite COLLATE NOCASE, which folds only A-Z, so a
 * Unicode-aware toLowerCase() here would call two names "the same theme" that
 * the server happily stores side by side (and vice versa would overwrite one).
 */
export function foldThemeName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** '' when valid, else the reason the name is rejected. */
export function themeNameError(raw: string): string {
  const name = normalizeThemeName(raw);
  if (!name) return 'theme name is required';
  if (name.length > THEME_NAME_MAX)
    return `theme name must be ${THEME_NAME_MAX} characters or fewer`;
  if (RESERVED_THEME_NAMES.includes(foldThemeName(name)))
    return `"${name}" is a reserved theme name`;
  return '';
}

// The Light palette = the OFFICIAL Monokai Pro Light filter wherever it
// defines a value, verified against the monokai.theme-monokai-pro-vscode
// 2.0.13 theme files (independently mirrored by mbadolato/iTerm2-Color-Schemes
// and Gogh; every accent clears WCAG 3:1 on its own background):
//
//   bg #faf4f2 · panels #ede7e5 · border #e0dad9 · fg #29242a
//   semi-muted #706b6e · comment #a59fa0
//   red #e14775 · orange #e16032 · yellow #cc7a0a
//   green #269d69 · cyan #1c8ca8 · purple #7058be
//
// fg_muted takes the semi-muted tier, not the comment tier: comments are
// 2.4:1 on this bg, and our muted role (timestamps, system events) matches
// the dark theme's ~5:1, which #706b6e does.
//
// Hues Monokai Pro Light does NOT define — the extended nick spread and the
// mIRC slots that borrow from it — keep the OKLCH mapping the iOS client uses
// (lurker-ios NickColor.swift: dark hue preserved, lightness remapped, ≥3:1).
const LIGHT_OVERRIDES: Record<string, SettingValue> = {
  'look.color.bg': '#faf4f2',
  'look.color.bg_soft': '#ede7e5',
  'look.color.fg': '#29242a',
  'look.color.fg_muted': '#706b6e',
  'look.color.accent': '#7058be', // purple, like dark's lavender accent
  'look.color.good': '#269d69',
  'look.color.warn': '#cc7a0a',
  'look.color.bad': '#e14775',
  'look.color.border': '#e0dad9',
  'look.color.message.alt_fg': '#4c474c', // between fg and fg_muted, like dark's
  // Same role pairing as dark (owner=red, op=accent-purple, voice=green).
  'look.color.member.owner': '#e14775',
  'look.color.member.admin': '#e16032',
  'look.color.member.op': '#7058be',
  'look.color.member.halfop': '#1c8ca8',
  'look.color.member.voice': '#269d69',
  // Same 19 hues as the dark nick palette, same order. The six entries that
  // ARE Monokai Pro accents take the official light accents; the extended
  // hues in between keep their OKLCH light variants.
  'look.nick.colors': [
    '#e14775', // official ← #ff6188
    '#e16032', // official ← #fc9867
    '#cc7a0a', // official ← #ffd866
    '#269d69', // official ← #a9dc76
    '#1c8ca8', // official ← #78dce8
    '#7058be', // official ← #ab9df2
    '#b52d55',
    '#9a5f30',
    '#a68500',
    '#688f2d',
    '#3d8f9b',
    '#7061b1',
    '#c12d5b',
    '#b66621',
    '#759247',
    '#409ba9',
    '#7767bd',
    '#4268c5',
    '#3163c0',
  ],
  // Chromatic slots track the nick palette like the dark defaults do: slots
  // whose dark value is a Pro accent take the official light accent, the rest
  // keep OKLCH.
  //
  // Slots 0/1/14/15 are the SAME literals as the dark preset, deliberately. A
  // mIRC code names a colour, and white/black/grey are the four the sender is
  // most likely to have paired with a background of their own — see the ⚠ on
  // the registry default. Re-tinting those per theme is what broke `\x0300,01`
  // and `\x0301,00` here. On this canvas white and light grey are the ones that
  // disappear when used bare; that is the sender's call to have made, and the
  // same deal the dark preset gives black.
  'look.color.mirc_colors': [
    '#ffffff', // 0  white
    '#000000', // 1  black
    '#3163c0', // 2  navy
    '#269d69', // 3  green (official)
    '#e14775', // 4  red (official)
    '#b52d55', // 5  maroon
    '#7058be', // 6  purple (official)
    '#e16032', // 7  orange (official)
    '#cc7a0a', // 8  yellow (official)
    '#688f2d', // 9  lime
    '#1c8ca8', // 10 teal (official)
    '#409ba9', // 11 cyan
    '#4268c5', // 12 blue
    '#c12d5b', // 13 magenta
    '#7f7f7f', // 14 gray       — mIRC's own grey
    '#d2d2d2', // 15 light gray — mIRC's own light grey
  ],
};

// Fresh array copies per call. REGISTRY's Object.freeze is shallow and
// LIGHT_OVERRIDES' arrays are module singletons — without copying, every
// consumer of a built-in theme would hold write-through references into the
// registry defaults themselves, and one in-place edit (palette[i] = x,
// .splice) by a future consumer (the theme editor) would corrupt the defaults
// and both built-ins for the whole session.
function copyValues(values: Record<string, SettingValue>): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

export function builtinThemes(): ThemePreset[] {
  const dark = themedDefaults();
  return [
    { id: 'dark', name: 'Monokai Plus', builtin: true, values: copyValues(dark) },
    {
      id: 'light',
      name: 'Monokai Plus Light',
      builtin: true,
      values: { ...copyValues(dark), ...copyValues(LIGHT_OVERRIDES) },
    },
  ];
}

export function isBuiltinThemeId(id: string): boolean {
  return id === 'dark' || id === 'light';
}

export function getBuiltinTheme(id: string): ThemePreset | null {
  return builtinThemes().find((t) => t.id === id) || null;
}
