// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { snapToPalette, srgbToOklab } from './colorSnap.js';

const rgb = (hex: string) => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
});

describe('srgbToOklab', () => {
  it('matches the reference values', () => {
    const [l, a, b] = srgbToOklab(rgb('#ffffff'));
    expect(l).toBeCloseTo(1, 3);
    expect(a).toBeCloseTo(0, 3);
    expect(b).toBeCloseTo(0, 3);
    const red = srgbToOklab(rgb('#ff0000'));
    expect(red[0]).toBeCloseTo(0.628, 3);
    expect(red[1]).toBeCloseTo(0.2249, 3);
    expect(red[2]).toBeCloseTo(0.1258, 3);
    expect(srgbToOklab(rgb('#000000'))[0]).toBe(0);
  });
});

describe('snapToPalette', () => {
  // Lurker's default palette, first six.
  const palette = ['#ff6188', '#fc9867', '#ffd866', '#a9dc76', '#78dce8', '#ab9df2'].map(rgb);

  it('lands a colour on the entry of its own tint', () => {
    expect(snapToPalette(rgb('#ff0000'), palette)).toBe(0); // red → the pink-red
    expect(snapToPalette(rgb('#00ff00'), palette)).toBe(3); // green
    expect(snapToPalette(rgb('#00ffff'), palette)).toBe(4); // cyan
    expect(snapToPalette(rgb('#8000ff'), palette)).toBe(5); // violet
    expect(snapToPalette(rgb('#ffff00'), palette)).toBe(2); // yellow
  });

  it('is exact for a colour already in the palette', () => {
    palette.forEach((entry, i) => expect(snapToPalette(entry, palette)).toBe(i));
  });

  it('gives black, white and grey somewhere to go', () => {
    for (const hex of ['#000000', '#ffffff', '#808080']) {
      const i = snapToPalette(rgb(hex), palette);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(palette.length);
    }
  });

  it('skips entries that name no colour, and says so when none does', () => {
    expect(snapToPalette(rgb('#ff0000'), [null, rgb('#00ff00'), rgb('#ff1010')])).toBe(2);
    expect(snapToPalette(rgb('#ff0000'), [null, null])).toBe(-1);
    expect(snapToPalette(rgb('#ff0000'), [])).toBe(-1);
  });

  it('takes the first of two equal entries', () => {
    expect(snapToPalette(rgb('#123456'), [rgb('#abcdef'), rgb('#abcdef')])).toBe(0);
  });
});
