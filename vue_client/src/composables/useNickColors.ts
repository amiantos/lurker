// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ComputedRef } from 'vue';
import { computed } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { useNetworksStore } from '../stores/networks.js';
import { useNickMetadataStore } from '../stores/nickMetadata.js';
import { nickColor, splitTextByTokens, type NickColorHash } from '../utils/nickColor.js';
import { parseHex } from '../lib/color.js';
import { themeColor } from '../lib/cssColor.js';
import { snapToPalette } from '../../../shared/colorSnap.js';
import { emojiFn } from './useEmoji.js';

type NetworkId = number | string | null | undefined;

export interface NickColorsAPI {
  color(nick: string, networkId?: NetworkId): string | null;
  splitText(
    text: string,
    nickSet: Set<string>,
    selfLower: string | null,
    networkId?: NetworkId,
  ): unknown[];
  selfColor: ComputedRef<string>;
  selfColorOn(networkId: NetworkId): string;
  snapped(hex: string | null | undefined): string | null;
}

// Provides reactive helpers that read coloring options from the settings store.
//   const nicks = useNickColors();
//   nicks.color(nick, networkId)             -> color string or null
//   nicks.splitText(text, nickSet, selfLower, networkId) -> segments
//   nicks.selfColor.value                     -> the theme's color for own nick
//   nicks.selfColorOn(networkId)              -> own nick's color on a network
//
// A nick's colour, first that applies (#1449, #1452):
//   1. the palette slot the user picked for that nick;
//   2. the `color` the nick published, snapped to the palette (never as sent);
//   3. the palette entry the nick hashes to.
// 1 and 2 need the network: a caller without one gets the hash.
export function useNickColors(): NickColorsAPI {
  const settings = useSettingsStore();
  const networks = useNetworksStore();
  // Made here, not on the first lookup: a store created inside a computed
  // registers its state while that computed is tracking, and the computed
  // then counts itself stale and runs a second time.
  useNickMetadataStore();

  const palette = computed(() => settings.effective('look.nick.colors') as string[]);
  const stopChars = computed(() => settings.effective('look.nick.color_stop_chars') as string);
  const hash = computed(() => settings.effective('look.nick.color_hash') as NickColorHash);
  const selfColor = computed(() => settings.effective('look.nick.self_color') as string);

  // The palette as sRGB, and what each published hex snapped to under it. Both
  // start over when the palette or the theme behind a `var()` entry changes.
  const paletteRgb = computed(() => palette.value.map((entry) => themeColor(entry)));
  const snaps = computed(() => {
    void paletteRgb.value;
    return new Map<string, string | null>();
  });

  function snapped(hex: string | null | undefined): string | null {
    if (!hex) return null;
    const known = snaps.value.get(hex);
    if (known !== undefined) return known;
    const rgb = parseHex(hex);
    const index = rgb ? snapToPalette(rgb, paletteRgb.value) : -1;
    const out = index < 0 ? null : palette.value[index];
    snaps.value.set(hex, out);
    return out;
  }

  function color(nick: string, networkId?: NetworkId): string | null {
    const meta = networkId != null && nick ? networks.metadataFor(networkId, nick) : null;
    if (meta?.colorSlot != null && palette.value.length) {
      return palette.value[meta.colorSlot % palette.value.length];
    }
    return (
      snapped(meta?.color) ??
      nickColor(nick, {
        palette: palette.value,
        stopChars: stopChars.value,
        hash: hash.value,
      })
    );
  }

  // Our own nick is the theme's `self_color`, unless we published a colour on
  // this network: then we see ourselves as everyone on this theme does.
  function selfColorOn(networkId: NetworkId): string {
    const own = networkId != null ? networks.states[networkId]?.nick : null;
    const mine = own ? networks.wireMetadataFor(networkId, own)?.color : null;
    return snapped(mine) ?? selfColor.value;
  }

  function splitText(
    text: string,
    nickSet: Set<string>,
    selfLower: string | null,
    networkId?: NetworkId,
  ): unknown[] {
    // emojiFn() reads the reactive emoji-ready signal, so message rows re-run
    // this split (showing glyphs) once the emoji table finishes loading.
    return splitTextByTokens(text, nickSet, selfLower, (n) => color(n, networkId), emojiFn());
  }

  return { color, splitText, selfColor, selfColorOn, snapped };
}

// Reactive accessor for the user-overridable mIRC palette (look.color.mirc_colors).
// Returned as a ComputedRef<string[]> — 16 entries, one per mIRC colour code 0..15.
// Callers hand this to segmentInlineStyle() / mircColor() so rendered colours
// update live when the user edits the palette in Settings.
export function useMircPalette(): ComputedRef<string[]> {
  const settings = useSettingsStore();
  return computed(() => settings.effective('look.color.mirc_colors') as string[]);
}
