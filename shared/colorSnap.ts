// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A colour somebody else chose, brought onto this theme (#1452): the nearest
// entry of a palette, by distance in OKLab. A metadata `color` is a raw hex
// that knows nothing of the viewer's theme; painted as sent it can vanish into
// the background or clash with everything around it, so it is never painted as
// sent. OKLab rather than hue alone: a grey has no hue, and two colours a
// hue-step apart can differ more in lightness than in tint.
//
// Pure maths, shared so every client snaps the same hex to the same slot.

export interface Rgb8 {
  r: number;
  g: number;
  b: number;
}

type Lab = [number, number, number];

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB (8-bit) to OKLab (Björn Ottosson's matrices). */
export function srgbToOklab({ r, g, b }: Rgb8): Lab {
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * The index of the palette entry nearest to `target`, or -1 when the palette
 * has no colour in it. A null entry (one that named no colour) is skipped. On
 * a tie the first wins, so the answer never depends on iteration quirks.
 */
export function snapToPalette(target: Rgb8, palette: ReadonlyArray<Rgb8 | null>): number {
  const [tl, ta, tb] = srgbToOklab(target);
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const entry = palette[i];
    if (!entry) continue;
    const [l, a, b] = srgbToOklab(entry);
    const distance = (l - tl) ** 2 + (a - ta) ** 2 + (b - tb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
