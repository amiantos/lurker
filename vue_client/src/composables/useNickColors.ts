// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ComputedRef } from 'vue';
import { computed } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { nickColor, splitTextByTokens, type NickColorHash } from '../utils/nickColor.js';
import { emojiFn } from './useEmoji.js';

export interface NickColorsAPI {
  color(nick: string): string | null;
  splitText(text: string, nickSet: Set<string>, selfLower: string | null): unknown[];
  selfColor: ComputedRef<string>;
}

// Provides reactive helpers that read coloring options from the settings store.
//   const nicks = useNickColors();
//   nicks.color(nick)                        -> color string or null
//   nicks.splitText(text, nickSet, selfLower) -> segments (URLs + nicks + text)
//   nicks.selfColor.value                     -> CSS color for own nick
export function useNickColors(): NickColorsAPI {
  const settings = useSettingsStore();

  const palette = computed(() => settings.effective('look.nick.colors') as string[]);
  const stopChars = computed(() => settings.effective('look.nick.color_stop_chars') as string);
  const hash = computed(() => settings.effective('look.nick.color_hash') as NickColorHash);
  const selfColor = computed(() => settings.effective('look.nick.self_color') as string);

  function color(nick: string): string | null {
    return nickColor(nick, {
      palette: palette.value,
      stopChars: stopChars.value,
      hash: hash.value,
    });
  }

  function splitText(text: string, nickSet: Set<string>, selfLower: string | null): unknown[] {
    // emojiFn() reads the reactive emoji-ready signal, so message rows re-run
    // this split (showing glyphs) once the emoji table finishes loading.
    return splitTextByTokens(text, nickSet, selfLower, color, emojiFn());
  }

  return { color, splitText, selfColor };
}

// Reactive accessor for the user-overridable mIRC palette (look.color.mirc_colors).
// Returned as a ComputedRef<string[]> — 16 entries, one per mIRC colour code 0..15.
// Callers hand this to segmentInlineStyle() / mircColor() so rendered colours
// update live when the user edits the palette in Settings.
export function useMircPalette(): ComputedRef<string[]> {
  const settings = useSettingsStore();
  return computed(() => settings.effective('look.color.mirc_colors') as string[]);
}
