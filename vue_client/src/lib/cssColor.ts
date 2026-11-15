// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Any CSS colour the browser accepts, as sRGB. Colour settings are free text
// (hex, rgb(), oklch(), var(--fg)), so whatever needs the actual colour — the
// picker's sliders, an avatar tile choosing its ink — asks the engine.

import { ref } from 'vue';
import { parseComputedRgb, parseHex } from './color.js';
import type { RGB } from './color.js';

/**
 * Resolve any CSS colour the browser accepts to sRGB. Hex is parsed directly;
 * everything else goes through a probe span appended to `host` (so var()
 * resolves against the live theme there) and its computed `color`. A browser that
 * keeps the computed value in a non-rgb form (oklch, color(srgb …)) gets a
 * second chance through a 1×1 canvas, which normalises anything it can paint.
 */
export function resolveCssColor(value: string, host: HTMLElement | null): RGB | null {
  const v = value.trim();
  if (!v) return null;
  const hex = parseHex(v);
  if (hex) return hex;
  if (!host || typeof document === 'undefined') return null;
  if (typeof CSS !== 'undefined' && CSS.supports && !CSS.supports('color', v)) return null;
  const probe = document.createElement('span');
  probe.style.color = v;
  // An unparseable value leaves the property empty: the browser said no.
  if (!probe.style.color) return null;
  host.appendChild(probe);
  const computedColor = getComputedStyle(probe).color;
  host.removeChild(probe);
  const rgb = parseComputedRgb(computedColor);
  if (rgb) return rgb;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = computedColor;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    // Nothing painted (transparent in a form the regex above didn't catch):
    // no colour to report, same as parseComputedRgb's zero-alpha refusal.
    if (d[3] === 0) return null;
    return { r: d[0], g: d[1], b: d[2] };
  } catch {
    return null;
  }
}

// Bumped by useTheme each time it writes the theme's custom properties, so a
// colour resolved through one of them is resolved again under the new theme.
export const themeEpoch = ref(0);
let epochCount = 0;
export function bumpThemeEpoch(): void {
  // Assigned, never incremented in place: the caller is a watchEffect, and
  // reading the ref there would make it depend on its own write.
  themeEpoch.value = ++epochCount;
}

const resolved = new Map<string, RGB | null>();
let resolvedEpoch = -1;

/**
 * A colour setting's value as sRGB against the document's theme, or null for
 * one that names no colour. Reactive: a caller inside a computed re-runs when
 * the theme changes. Hex never touches the DOM; anything else is resolved once
 * per theme and kept, as a buffer asks for the same few colours on every row.
 */
export function themeColor(value: string | null | undefined): RGB | null {
  const v = value?.trim();
  if (!v) return null;
  const hex = parseHex(v);
  if (hex) return hex;
  const epoch = themeEpoch.value;
  if (epoch !== resolvedEpoch) {
    resolved.clear();
    resolvedEpoch = epoch;
  }
  if (resolved.has(v)) return resolved.get(v) ?? null;
  const rgb = typeof document === 'undefined' ? null : resolveCssColor(v, document.body);
  resolved.set(v, rgb);
  return rgb;
}
