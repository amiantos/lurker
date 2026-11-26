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
// colour the nick published fitted to the palette, else the hash.
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

  it('never paints a published colour as sent: it is fitted to the palette', () => {
    const networks = useNetworksStore();
    const nicks = useNickColors();
    // A dark green: unreadable on a dark theme as sent.
    networks.applyUserMetadata(1, 'bob', { color: '#3b5940' });
    const shown = nicks.color('bob', 1);
    expect(shown).toMatch(/^#[0-9a-f]{6}$/);
    expect(shown).not.toBe('#3b5940');
    expect(shown).toBe(nicks.adapted('#3b5940'));
    // Still green: more green than red or blue.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(shown!.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    // A colour of the palette is itself.
    expect(nicks.adapted(palette[4])).toBe(palette[4]);
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
    const before = nicks.color('bob', 1);
    settings.values = { 'look.nick.colors': ['#103010', '#104010', '#301010'] } as never;
    // Fitted to the new palette's (much darker) range, not kept from the old.
    expect(nicks.color('bob', 1)).not.toBe(before);
    expect(nicks.color('bob', 1)).toBe(nicks.adapted('#00ff00'));
    expect(nicks.color('carol', 1)).toBe('#104010');
  });

  it('shows our own nick in the colour we published, where we did', () => {
    const networks = useNetworksStore();
    const nicks = useNickColors();
    networks.states[1] = { networkId: 1, channels: [], nick: 'me' };
    networks.states[2] = { networkId: 2, channels: [], nick: 'me' };
    expect(nicks.selfColorOn(1)).toBe(nicks.selfColor.value);
    networks.applyUserMetadata(1, 'me', { color: '#00ff00' });
    expect(nicks.selfColorOn(1)).toBe(nicks.adapted('#00ff00'));
    expect(nicks.selfColorOn(2)).toBe(nicks.selfColor.value);
    expect(nicks.selfColorOn(null)).toBe(nicks.selfColor.value);
  });
});
