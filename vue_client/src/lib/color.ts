// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Framework-free colour math for the colour picker: hex <-> rgb <-> hsv,
// WCAG contrast, and the harmony swatches. Everything here is sRGB and
// 8-bit; the picker edits literal colours and anything fancier (var(),
// color-mix(), oklch()) is resolved to sRGB by the browser before it gets
// here (see cssColor.ts's resolveCssColor).

// Shared with the avatar tiles, whose ink follows it (shared/avatarTiles.ts).
import { relativeLuminance } from '../../../shared/avatarTiles.js';
export { relativeLuminance };

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** h in degrees 0..360 (exclusive), s and v in 0..1. */
export interface HSV {
  h: number;
  s: number;
  v: number;
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Parse a CSS hex literal (#rgb, #rgba, #rrggbb, #rrggbbaa). A translucent
 * alpha is dropped: the picker has no alpha channel, so such a value edits as
 * its opaque colour and comes back opaque once the user moves a slider. A ZERO
 * alpha is different — the colour paints nothing, so its RGB is meaningless and
 * the parse fails rather than reporting black.
 */
export function parseHex(input: string): RGB | null {
  const m = HEX_RE.exec(input.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length <= 4) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (hex.length === 8 && hex.slice(6) === '00') return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function clamp255(n: number): number {
  return Math.min(255, Math.max(0, Math.round(n)));
}

/** Lower-case #rrggbb, the one canonical spelling the picker writes. */
export function toHex({ r, g, b }: RGB): string {
  return '#' + [r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsv({ r, g, b }: RGB): HSV {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const hh = (((h % 360) + 360) % 360) / 60;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  let rn: number;
  let gn: number;
  let bn: number;
  switch (i) {
    case 0:
      [rn, gn, bn] = [v, t, p];
      break;
    case 1:
      [rn, gn, bn] = [q, v, p];
      break;
    case 2:
      [rn, gn, bn] = [p, v, t];
      break;
    case 3:
      [rn, gn, bn] = [p, q, v];
      break;
    case 4:
      [rn, gn, bn] = [t, p, v];
      break;
    default:
      [rn, gn, bn] = [v, p, q];
  }
  return { r: clamp255(rn * 255), g: clamp255(gn * 255), b: clamp255(bn * 255) };
}

/** WCAG 2 contrast ratio, always >= 1 (order of the two colours is irrelevant). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** "4.5:1" — one decimal, the way contrast is quoted everywhere. */
export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(1)}:1`;
}

/** Linear mix of two colours in sRGB; t = 0 gives `a`, t = 1 gives `b`. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return {
    r: clamp255(a.r + (b.r - a.r) * t),
    g: clamp255(a.g + (b.g - a.g) * t),
    b: clamp255(a.b + (b.b - a.b) * t),
  };
}

export interface HarmonySwatch {
  /** Short label for the title attribute: "complement", "triad", "lighter"… */
  label: string;
  hex: string;
}

const WHITE: RGB = { r: 255, g: 255, b: 255 };
const BLACK: RGB = { r: 0, g: 0, b: 0 };

/**
 * The harmony row: hue rotations of the colour (complement, two triadic, two
 * analogous) followed by two tints toward white and two shades toward black.
 * Rotations keep the colour's own saturation and value, so a muted colour gets
 * muted companions rather than neon ones. A grey has no hue to rotate, so its
 * rotations collapse to itself and are dropped; the tints and shades remain.
 */
export function harmonies(base: RGB): HarmonySwatch[] {
  const hsv = rgbToHsv(base);
  const out: HarmonySwatch[] = [];
  const baseHex = toHex(base);
  const rotated = (label: string, deg: number) => {
    const hex = toHex(hsvToRgb({ ...hsv, h: hsv.h + deg }));
    if (hex !== baseHex) out.push({ label, hex });
  };
  rotated('complement', 180);
  rotated('triad', 120);
  rotated('triad', 240);
  rotated('analogous', -30);
  rotated('analogous', 30);
  out.push({ label: 'lighter', hex: toHex(mix(base, WHITE, 0.25)) });
  out.push({ label: 'lighter', hex: toHex(mix(base, WHITE, 0.5)) });
  out.push({ label: 'darker', hex: toHex(mix(base, BLACK, 0.25)) });
  out.push({ label: 'darker', hex: toHex(mix(base, BLACK, 0.5)) });
  // A tint/shade of an extreme colour can land on the colour itself (white
  // lighter is white) or on a neighbour; one swatch per distinct colour.
  const seen = new Set<string>([baseHex]);
  return out.filter((s) => (seen.has(s.hex) ? false : (seen.add(s.hex), true)));
}

/**
 * Parse the computed `color` the browser hands back for a probe element:
 * `rgb(r, g, b)`, `rgba(r, g, b, a)` or the modern `rgb(r g b / a)`. Returns
 * null for anything else (a browser that keeps `oklch(...)` as the computed
 * value, say) so the caller can fall back to a canvas read — and null for a
 * zero alpha, in any of its spellings (`0`, `0.0`, `0%`): browsers serialise
 * `transparent` as `rgba(0, 0, 0, 0)`, whose RGB says nothing about the colour.
 */
export function parseComputedRgb(input: string): RGB | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(
    input.trim(),
  );
  if (!m) return null;
  if (m[4] !== undefined) {
    const alpha = parseFloat(m[4]) / (m[4].endsWith('%') ? 100 : 1);
    if (!(alpha > 0)) return null;
  }
  return { r: clamp255(Number(m[1])), g: clamp255(Number(m[2])), b: clamp255(Number(m[3])) };
}
