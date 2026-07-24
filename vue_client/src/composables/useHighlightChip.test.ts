// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => vi.resetModules());

// Load a fresh useHighlightChip over refs we control, following useAppBadge's
// pattern: `vue` is imported AFTER the module reset so the refs come from the
// same reactivity instance the composable's `computed` will track.
async function load(total = 0, unreadDisplay = 'full') {
  const { ref } = await import('vue');
  const totalRef = ref(total);
  const displayRef = ref(unreadDisplay);
  vi.doMock('../stores/buffers.js', () => ({
    useBuffersStore: () => ({
      get totalHighlights() {
        return totalRef.value;
      },
    }),
  }));
  vi.doMock('../stores/settings.js', () => ({
    useSettingsStore: () => ({
      effective: (key: string) =>
        key === 'look.buffer_list.unread_display' ? displayRef.value : undefined,
    }),
  }));
  const mod = await import('./useHighlightChip.js');
  return { ...mod, totalRef, displayRef };
}

describe('useHighlightChip', () => {
  it('reports the store total verbatim, so the chip and the app-icon badge agree', async () => {
    const { useHighlightChip, totalRef } = await load(3);
    const chip = useHighlightChip();
    expect(chip.count.value).toBe(3);
    expect(chip.label.value).toBe('3');

    totalRef.value = 12;
    expect(chip.count.value).toBe(12);
    expect(chip.label.value).toBe('12');
  });

  it('hides at zero — nothing waiting means no chip', async () => {
    const { useHighlightChip, totalRef } = await load(0);
    const chip = useHighlightChip();
    expect(chip.show.value).toBe(false);

    totalRef.value = 1;
    expect(chip.show.value).toBe(true);
  });

  it('shows in every unread_display mode except off', async () => {
    const { useHighlightChip, displayRef } = await load(4);
    const chip = useHighlightChip();
    for (const mode of ['full', 'highlights', 'badge']) {
      displayRef.value = mode;
      expect(chip.show.value).toBe(true);
    }
    // "off" means row color/weight is the only cue — the chip is exactly the
    // numeric cue that mode turns down.
    displayRef.value = 'off';
    expect(chip.show.value).toBe(false);
  });

  it('stays hidden at zero even when unread_display would allow it', async () => {
    const { useHighlightChip, displayRef } = await load(0);
    const chip = useHighlightChip();
    displayRef.value = 'highlights';
    expect(chip.show.value).toBe(false);
  });

  it('caps a four-figure total so the chip cannot stretch its host control', async () => {
    const { useHighlightChip } = await load(1500);
    const chip = useHighlightChip();
    expect(chip.label.value).toBe('>999');
    expect(chip.show.value).toBe(true);
  });
});
