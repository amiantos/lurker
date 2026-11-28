// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { watchEffect } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { useViewport } from './useViewport.js';
import { parseComputedRgb, parseHex } from '../lib/color.js';
import { bumpThemeEpoch } from '../lib/cssColor.js';

// Maps each settings key to the CSS custom property it controls. Anything in
// here is live-rewritten on :root whenever the settings store changes, so the
// whole UI re-themes immediately when the user edits a key in Settings.
export const COLOR_VARS: Record<string, string> = {
  'look.color.bg': '--bg',
  'look.color.bg_soft': '--bg-soft',
  'look.color.fg': '--fg',
  'look.color.fg_muted': '--fg-muted',
  'look.color.accent': '--accent',
  'look.color.link': '--link',
  'look.color.good': '--good',
  'look.color.warn': '--warn',
  'look.color.bad': '--bad',
  'look.color.border': '--border',
  'look.color.message.alt_bg': '--alt-bg',
  'look.color.message.alt_fg': '--alt-fg',
  // Empty by default, and setProperty('') removes the variable, so the rule
  // that reads it falls back to the row's own colour.
  'look.color.message.self_fg': '--self-fg',
  'look.color.buffer.unread': '--buffer-unread',
  'look.color.buffer.highlight': '--buffer-highlight',
  'look.color.buffer.header': '--buffer-header',
  'look.color.buffer.name': '--buffer-name',
  'look.color.buffer.muted': '--buffer-muted',
  'look.color.buffer.offline': '--buffer-offline',
  'look.color.member.owner': '--member-owner',
  'look.color.member.admin': '--member-admin',
  'look.color.member.op': '--member-op',
  'look.color.member.halfop': '--member-halfop',
  'look.color.member.voice': '--member-voice',
};

let installed = false;

// UA hint for scrollbars / form controls / system surfaces, derived from the
// effective background rather than any theme metadata — a hand-picked palette
// deserves the right chrome as much as the built-in Light theme does.
// Perceived luminance (ITU-R BT.601) > 140 reads as a light surface.
function schemeFromLuma(r: number, g: number, b: number): 'light' | 'dark' {
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? 'light' : 'dark';
}

// Hex fallback for environments where computed style is unavailable (jsdom).
function colorSchemeFor(bg: string): 'light' | 'dark' {
  const rgb = parseHex(bg);
  if (!rgb) return 'dark';
  return schemeFromLuma(rgb.r, rgb.g, rgb.b);
}

// Color settings are free-text strings (the server accepts any string; the row
// editor is a text input), so the background is NOT guaranteed to be hex —
// 'white', 'rgb(252,252,250)', or an oklch() must still flip the chrome. Ask
// the engine instead: the body paints `background: var(--bg)` (main.css), and
// getComputedStyle resolves any color form to rgb()/rgba() synchronously,
// including the vars this same watchEffect just wrote. Fall back to hex
// parsing when there's no usable answer (jsdom, transparent).
function computedColorScheme(fallbackBg: string): 'light' | 'dark' {
  const resolved = document.body ? getComputedStyle(document.body).backgroundColor : '';
  // parseComputedRgb refuses a zero alpha in any spelling (`0`, `0.0`, `0%`):
  // a transparent body serialises as `rgba(0, 0, 0, 0)`, whose RGB is
  // meaningless, so it falls through to the hex fallback like jsdom does.
  const rgb = parseComputedRgb(resolved || '');
  if (rgb) return schemeFromLuma(rgb.r, rgb.g, rgb.b);
  return colorSchemeFor(fallbackBg);
}

export function useTheme(): void {
  if (installed) return;
  installed = true;
  const settings = useSettingsStore();
  const { isMobile } = useViewport();
  const root = document.documentElement;

  watchEffect(() => {
    for (const [key, cssVar] of Object.entries(COLOR_VARS)) {
      root.style.setProperty(cssVar, String(settings.effective(key)));
    }
    root.style.setProperty('--mono', String(settings.effective('look.font.family')));
    // Mobile gets its own size so a large desktop setting (and the large icons
    // that come with it) doesn't have to follow you onto a phone. The viewport
    // breakpoint flips live, so resizing across it re-applies the right value.
    const fontSizeKey = isMobile.value ? 'look.font.size.mobile' : 'look.font.size';
    root.style.setProperty('--font-size', `${settings.effective(fontSizeKey)}px`);
    root.style.setProperty('--font-weight', String(settings.effective('look.font.weight')));
    const macSmoothing = !!settings.effective('look.font.smoothing_macos');
    root.style.setProperty(
      '--font-smoothing-webkit',
      macSmoothing ? 'subpixel-antialiased' : 'auto',
    );
    root.style.setProperty('--font-smoothing-moz', 'auto');
    // Compact-layout density (#1186): the same three numbers the phone apps
    // read, in the registry's units (px, percent, characters), turned into
    // the lengths MessageList's compact rules consume.
    root.style.setProperty(
      '--modern-group-gap',
      `${settings.effective('look.message.modern.group_gap')}px`,
    );
    root.style.setProperty(
      '--modern-line-height',
      String(Number(settings.effective('look.message.modern.line_height')) / 100),
    );
    root.style.setProperty(
      '--modern-indent',
      `${settings.effective('look.message.modern.indent')}ch`,
    );
    // The traditional layout's nick column (#1405), as the lengths its grid
    // and cells take: a floor for the track (a cell's 1ch of padding
    // included), a cap for each cell's text. A minimum over the maximum is
    // the maximum, as a fixed column.
    const nickMax = Number(settings.effective('look.message.traditional.nick_column_max')) || 0;
    const nickMin = Number(settings.effective('look.message.traditional.nick_column_min')) || 0;
    const nickFloor = nickMax > 0 ? Math.min(nickMin, nickMax) : nickMin;
    root.style.setProperty('--nick-col-min', nickFloor > 0 ? `${nickFloor + 1}ch` : '0px');
    root.style.setProperty('--nick-col-max', nickMax > 0 ? `${nickMax}ch` : 'none');
    root.style.colorScheme = computedColorScheme(String(settings.effective('look.color.bg')));
    bumpThemeEpoch();
  });
}
