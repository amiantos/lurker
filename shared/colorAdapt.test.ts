// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { adaptToPalette, rgbToHex, snapToPalette, srgbToOklab } from './colorAdapt.js';

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

// Lurker's default palette, first six: red, orange, yellow, green, cyan, violet.
const palette = ['#ff6188', '#fc9867', '#ffd866', '#a9dc76', '#78dce8', '#ab9df2'].map(rgb);
const lch = (hex: string) => {
  const [l, a, b] = srgbToOklab(rgb(hex));
  return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
};
const adapt = (hex: string, onto = palette) => rgbToHex(adaptToPalette(rgb(hex), onto)!);

describe('adaptToPalette', () => {
  const lightness = palette.map((p) => srgbToOklab(p)[0]);
  const darkest = Math.min(...lightness);
  const lightest = Math.max(...lightness);
  const vivid = Math.max(
    ...palette.map((p) => Math.hypot(...(srgbToOklab(p).slice(1) as [number, number]))),
  );

  // The colour that started this: snapped to the nearest entry it came out blue.
  it('keeps a dark green green, and makes it readable', () => {
    const before = lch('#3b5940');
    const after = lch(adapt('#3b5940'));
    expect(Math.abs(after.h - before.h)).toBeLessThan(4);
    expect(before.l).toBeLessThan(darkest);
    expect(after.l).toBeCloseTo(darkest, 1);
  });

  it('keeps the hue of whatever it is given', () => {
    for (const hex of ['#ff0000', '#0000ff', '#008080', '#8b4513', '#800080', '#ff8800']) {
      const before = lch(hex);
      const after = lch(adapt(hex));
      const turn = Math.min(Math.abs(after.h - before.h), 360 - Math.abs(after.h - before.h));
      expect(turn).toBeLessThan(6);
    }
  });

  it("stays inside the palette's lightness and chroma", () => {
    for (const hex of [
      '#000000',
      '#ffffff',
      '#00ff00',
      '#ff00ff',
      '#0000ff',
      '#3b5940',
      '#ffff00',
    ]) {
      const after = lch(adapt(hex));
      expect(after.l).toBeGreaterThan(darkest - 0.02);
      expect(after.l).toBeLessThan(lightest + 0.02);
      expect(after.c).toBeLessThan(vivid + 0.02);
    }
  });

  it("leaves the palette's own colours as they are", () => {
    for (const hex of ['#ff6188', '#a9dc76', '#78dce8']) expect(adapt(hex)).toBe(hex);
  });

  it('keeps a grey grey', () => {
    for (const hex of ['#000000', '#808080', '#ffffff'])
      expect(lch(adapt(hex)).c).toBeLessThan(0.01);
  });

  it('follows a light theme down', () => {
    const light = ['#b3002d', '#a04a00', '#2e6b00', '#00647a'].map(rgb);
    // A pale cyan (L 0.91) comes down to the light theme's dark inks.
    expect(lch(adapt('#a0f1ff', light)).l).toBeLessThan(0.55);
  });

  it('says so when the palette has no colour in it', () => {
    expect(adaptToPalette(rgb('#ff0000'), [null])).toBeNull();
    expect(adaptToPalette(rgb('#ff0000'), [])).toBeNull();
  });
});

describe('snapToPalette', () => {
  it('lands a colour on the entry of its own tint, however dark it is', () => {
    expect(snapToPalette(rgb('#ff1060'), palette)).toBe(0); // crimson → the pink-red
    expect(snapToPalette(rgb('#00ff00'), palette)).toBe(3); // green
    expect(snapToPalette(rgb('#3b5940'), palette)).toBe(3); // dark green: still green
    expect(snapToPalette(rgb('#00ffff'), palette)).toBe(4); // cyan
    expect(snapToPalette(rgb('#008080'), palette)).toBe(4); // teal
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
