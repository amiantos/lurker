// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
  AVATAR_INK_LUMINANCE,
  BUILTIN_AVATAR_SETS,
  DEFAULT_AVATAR_SET,
  LEGACY_AVATAR_SET_IDS,
  avatarInk,
  currentAvatarSetId,
  isBuiltinAvatarSetId,
  relativeLuminance,
  tileIndex,
  tileUrl,
} from './avatarTiles.js';
import { REGISTRY } from './settingsRegistry.js';
import { getBuiltinTheme } from './themePresets.js';

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
};

describe('avatarInk', () => {
  it('is dark on a light colour, light on a dark one, and dark for no colour', () => {
    expect(avatarInk(rgb('#ffffff'))).toBe('dark');
    expect(avatarInk(rgb('#ffd866'))).toBe('dark');
    expect(avatarInk(rgb('#000000'))).toBe('light');
    expect(avatarInk(rgb('#3163c0'))).toBe('light');
    expect(avatarInk(null)).toBe('dark');
  });

  it('turns at the threshold: above it dark, at it light', () => {
    // Greys either side of the line, found from the luminance itself.
    let below = 0;
    while (relativeLuminance({ r: below + 1, g: below + 1, b: below + 1 }) <= AVATAR_INK_LUMINANCE)
      below++;
    const above = below + 1;
    expect(avatarInk({ r: below, g: below, b: below })).toBe('light');
    expect(avatarInk({ r: above, g: above, b: above })).toBe('dark');
  });

  // The threshold is where it is so each built-in theme keeps the ink its
  // palette was drawn for. A palette edit that crosses it should fail here.
  it("gives the dark theme's whole nick palette dark ink", () => {
    const palette = REGISTRY.find((o) => o.key === 'look.nick.colors')!.default as string[];
    expect(palette.length).toBeGreaterThan(0);
    for (const hex of palette) expect([hex, avatarInk(rgb(hex))]).toEqual([hex, 'dark']);
  });

  it("gives the light theme's whole nick palette light ink", () => {
    const light = getBuiltinTheme('light')!;
    const palette = light.values['look.nick.colors'] as string[];
    expect(palette.length).toBeGreaterThan(0);
    for (const hex of palette) expect([hex, avatarInk(rgb(hex))]).toEqual([hex, 'light']);
  });
  // The apps draw a server line's mark on the theme's muted grey; the number
  // is theirs too (AvatarInk.luminanceThreshold in both kits).
  it("keeps dark ink on the dark theme's muted grey", () => {
    expect(AVATAR_INK_LUMINANCE).toBe(0.28);
    expect(avatarInk(rgb('#939293'))).toBe('dark');
    expect(avatarInk(rgb('#706b6e'))).toBe('light');
  });
});

describe('the bundled sets', () => {
  it('has the default among them', () => {
    expect(isBuiltinAvatarSetId(DEFAULT_AVATAR_SET)).toBe(true);
    expect(REGISTRY.find((o) => o.key === 'look.avatars.set')!.default).toBe(DEFAULT_AVATAR_SET);
  });

  it('moves each id from before the ink was automatic to the set it became', () => {
    expect(currentAvatarSetId('initial-light')).toBe('initial');
    expect(currentAvatarSetId('initial-dark')).toBe('initial');
    expect(currentAvatarSetId('plain-light')).toBe('plain');
    expect(currentAvatarSetId('plain-dark')).toBe('plain');
    expect([...LEGACY_AVATAR_SET_IDS].sort()).toEqual([
      'initial-dark',
      'initial-light',
      'plain-dark',
      'plain-light',
    ]);
    for (const old of LEGACY_AVATAR_SET_IDS) {
      expect(isBuiltinAvatarSetId(old)).toBe(false);
      expect(isBuiltinAvatarSetId(currentAvatarSetId(old))).toBe(true);
    }
  });

  it('leaves every other id alone, an inherited name included', () => {
    for (const id of ['ealain', 'initial', 'plain', '12', 'toString', 'constructor']) {
      expect(currentAvatarSetId(id)).toBe(id);
    }
  });

  it('keeps a Plain set in both inks', () => {
    const plain = BUILTIN_AVATAR_SETS.find((s) => s.id === 'plain')!;
    expect(plain.urls).toEqual({ light: '/avatars/plain-light', dark: '/avatars/plain-dark' });
  });
});

describe('tileIndex', () => {
  it('is deterministic and inside the set', () => {
    const a = tileIndex('bob', 100);
    expect(a).toBe(tileIndex('bob', 100));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
    for (const nick of ['a', 'Zed', 'someone_long_nick', 'ñandú', '[bracket]']) {
      const i = tileIndex(nick, 7);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(7);
    }
  });

  it('normalises the nick the way the nick colour does', () => {
    expect(tileIndex('Bob', 100)).toBe(tileIndex('bob', 100));
    expect(tileIndex('bob_', 100)).toBe(tileIndex('bob', 100));
    expect(tileIndex('bob|away', 100)).toBe(tileIndex('bob', 100));
    expect(tileIndex('_bob', 100)).toBe(tileIndex('_bob', 100));
    // Different stop characters, different trim.
    expect(tileIndex('bob-x', 100, '-')).toBe(tileIndex('bob', 100, '-'));
  });

  it('spreads nicks over the set', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) seen.add(tileIndex(`nick${i}`, 32));
    expect(seen.size).toBe(32);
  });

  it('answers -1 when there is nothing to pick', () => {
    expect(tileIndex('', 10)).toBe(-1);
    expect(tileIndex(null, 10)).toBe(-1);
    expect(tileIndex('bob', 0)).toBe(-1);
    // A nick that is all stop characters keeps them, as the colour does.
    expect(tileIndex('_', 10)).toBeGreaterThanOrEqual(0);
  });
});

describe('tileUrl', () => {
  it('numbers tiles from 000', () => {
    expect(tileUrl('/avatars/ealain', 0, 'webp')).toBe('/avatars/ealain/000.webp');
    expect(tileUrl('/avatars/ealain/', 42, 'png')).toBe('/avatars/ealain/042.png');
    expect(tileUrl('/api/avatar-sets/7', 123, 'webp')).toBe('/api/avatar-sets/7/123.webp');
  });
});
