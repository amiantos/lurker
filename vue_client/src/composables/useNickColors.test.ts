// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(),
}));

import { useNickColors } from './useNickColors.js';
import { useNetworksStore } from '../stores/networks.js';
import { useNickMetadataStore } from '../stores/nickMetadata.js';
import { useSettingsStore } from '../stores/settings.js';

// Which colour a nick gets (#1449, #1452): the slot the user picked, else the
// colour the nick published snapped to the palette, else the hash.
describe('nick colours with metadata', () => {
  let palette: string[];

  beforeEach(() => {
    setActivePinia(createPinia());
    palette = useSettingsStore().effective('look.nick.colors') as string[];
  });

  it('is the hashed palette colour with no network or no metadata', () => {
    const nicks = useNickColors();
    const hashed = nicks.color('bob');
    expect(palette).toContain(hashed);
    expect(nicks.color('bob', 1)).toBe(hashed);
  });

  it('never paints a published colour as sent: it lands on the palette', () => {
    const networks = useNetworksStore();
    const nicks = useNickColors();
    networks.applyUserMetadata(1, 'bob', { color: '#00ff00' });
    const shown = nicks.color('bob', 1);
    expect(shown).not.toBe('#00ff00');
    expect(palette).toContain(shown);
    // The palette's own green, not whatever bob hashes to.
    expect(shown).toBe(nicks.snapped('#00ff00'));
    // A colour of the palette is itself.
    expect(nicks.snapped(palette[4])).toBe(palette[4]);
    // Only on the network it was published on.
    expect(nicks.color('bob', 2)).toBe(nicks.color('bob'));
  });

  it('puts the slot the user picked ahead of the published colour', () => {
    const networks = useNetworksStore();
    const nicks = useNickColors();
    networks.applyUserMetadata(1, 'bob', { color: '#00ff00' });
    useNickMetadataStore().applyUpdate(1, 'bob', { color: '1' });
    expect(nicks.color('bob', 1)).toBe(palette[1]);
    // A slot past the end of a shorter palette wraps.
    useNickMetadataStore().applyUpdate(1, 'bob', { color: String(palette.length + 2) });
    expect(nicks.color('bob', 1)).toBe(palette[2]);
  });

  it('follows the palette when it changes', () => {
    const networks = useNetworksStore();
    const settings = useSettingsStore();
    const nicks = useNickColors();
    networks.applyUserMetadata(1, 'bob', { color: '#00ff00' });
    useNickMetadataStore().applyUpdate(1, 'carol', { color: '1' });
    nicks.color('bob', 1);
    settings.values = { 'look.nick.colors': ['#101010', '#20e020', '#e02020'] } as never;
    expect(nicks.color('bob', 1)).toBe('#20e020');
    expect(nicks.color('carol', 1)).toBe('#20e020');
  });

  it('shows our own nick in the colour we published, where we did', () => {
    const networks = useNetworksStore();
    const nicks = useNickColors();
    networks.states[1] = { networkId: 1, channels: [], nick: 'me' };
    networks.states[2] = { networkId: 2, channels: [], nick: 'me' };
    expect(nicks.selfColorOn(1)).toBe(nicks.selfColor.value);
    networks.applyUserMetadata(1, 'me', { color: '#00ff00' });
    expect(nicks.selfColorOn(1)).toBe(nicks.snapped('#00ff00'));
    expect(nicks.selfColorOn(2)).toBe(nicks.selfColor.value);
    expect(nicks.selfColorOn(null)).toBe(nicks.selfColor.value);
  });
});
