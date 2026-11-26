// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A colour somebody else chose, brought onto this theme (#1452). A metadata
// `color` is a raw hex that knows nothing of the viewer's theme; painted as
// sent it can vanish into the background or clash with everything around it,
// so it is never painted as sent.
//
// `adaptToPalette` keeps the colour's hue and brings its lightness and chroma
// inside the range of the theme's nick palette: a dark green stays green and
// reads like the nicks around it. This is
// Halloy's approach (`adapt_nickname_color`), worked in OKLCH against the
// palette where Halloy has a single nickname colour. Snapping to the nearest
// palette entry was tried first and dropped: a palette holds a handful of
// hues at one lightness, so lightness decided the match and a dark green
// landed on blue.
//
// `snapToPalette` still picks a palette SLOT for a colour (`/nickmeta <nick>
// color #hex`); it adapts first, so it too matches on hue.
//
// Pure maths, shared so every client shows the same hex the same way.

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

function oklabToLinear([l, a, b]: Lab): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function inGamut(lab: Lab): boolean {
  return oklabToLinear(lab).every((c) => c >= -1e-4 && c <= 1 + 1e-4);
}

function gamma(linearChannel: number): number {
  const c = Math.min(1, Math.max(0, linearChannel));
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
}

function fromLch(l: number, c: number, h: number): Lab {
  return [l, c * Math.cos(h), c * Math.sin(h)];
}

/** The most chroma sRGB can show at this lightness and hue. */
function maxChroma(l: number, h: number): number {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(fromLch(l, mid, h))) lo = mid;
    else hi = mid;
  }
  return lo;
}

// A colour as lightness, chroma, hue (radians) and saturation: its chroma as a
// share of what its lightness and hue allow, so a dark green and a pastel
// green can be as "green" as each other. A near-grey has no hue to keep.
function toLchs(rgb: Rgb8): { l: number; c: number; h: number; s: number } {
  const [l, a, b] = srgbToOklab(rgb);
  const c = Math.hypot(a, b);
  if (c < 0.01) return { l, c: 0, h: 0, s: 0 };
  const h = Math.atan2(b, a);
  const most = maxChroma(l, h);
  return { l, c, h, s: most > 0 ? Math.min(1, c / most) : 0 };
}

/**
 * `target` as this palette would show it:
 * - its own hue;
 * - its own lightness, held inside the palette's range (the darkest and
 *   lightest entries are what the theme's author found readable);
 * - its own saturation, with no more chroma than the palette's most vivid entry.
 * Null when the palette has no colour in it. A null entry is skipped.
 */
export function adaptToPalette(target: Rgb8, palette: ReadonlyArray<Rgb8 | null>): Rgb8 | null {
  const tones = palette.filter((entry): entry is Rgb8 => !!entry).map(toLchs);
  if (!tones.length) return null;
  const lightest = Math.max(...tones.map((t) => t.l));
  const darkest = Math.min(...tones.map((t) => t.l));
  const vivid = Math.max(...tones.map((t) => t.c));
  const { l: ownL, h, s } = toLchs(target);
  const l = Math.min(lightest, Math.max(darkest, ownL));
  const c = Math.min(s * maxChroma(l, h), vivid);
  const [r, g, b] = oklabToLinear(fromLch(l, c, h));
  return { r: gamma(r), g: gamma(g), b: gamma(b) };
}

/** `#rrggbb`, lower case. */
export function rgbToHex({ r, g, b }: Rgb8): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The index of the palette entry nearest in tint to `target`, or -1 when the
 * palette has no colour in it. The colour is adapted first and lightness is
 * left out of the distance: within a palette it says little, and it is what
 * sent a dark green to blue. A null entry is skipped. On a tie the first wins,
 * so the answer never depends on iteration quirks.
 */
export function snapToPalette(target: Rgb8, palette: ReadonlyArray<Rgb8 | null>): number {
  const adapted = adaptToPalette(target, palette);
  if (!adapted) return -1;
  const [, ta, tb] = srgbToOklab(adapted);
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const entry = palette[i];
    if (!entry) continue;
    const [, a, b] = srgbToOklab(entry);
    const distance = (a - ta) ** 2 + (b - tb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
