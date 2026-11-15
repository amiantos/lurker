// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import { bumpThemeEpoch, themeColor } from './cssColor.js';

// The engine's answer for a probe, stubbed: what a var() resolves to is the
// theme's business, and the theme is what changes under the cache here.
function engineSays(color: () => string) {
  return vi
    .spyOn(window, 'getComputedStyle')
    .mockImplementation(() => ({ color: color() }) as CSSStyleDeclaration);
}

describe('themeColor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    bumpThemeEpoch();
  });

  it('reads hex without asking the engine', () => {
    const spy = engineSays(() => 'rgb(1, 2, 3)');
    expect(themeColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(themeColor(' #0f0 ')).toEqual({ r: 0, g: 255, b: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('is null for nothing', () => {
    expect(themeColor(null)).toBeNull();
    expect(themeColor(undefined)).toBeNull();
    expect(themeColor('  ')).toBeNull();
  });

  it('asks the engine once per colour per theme', () => {
    const spy = engineSays(() => 'rgb(10, 20, 30)');
    expect(themeColor('var(--fg)')).toEqual({ r: 10, g: 20, b: 30 });
    expect(themeColor('var(--fg)')).toEqual({ r: 10, g: 20, b: 30 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('span')).toBeNull();
  });

  it('resolves again after the theme changes, and a computed over it follows', () => {
    let now = 'rgb(252, 252, 250)';
    engineSays(() => now);
    const fg = computed(() => themeColor('var(--fg)'));
    expect(fg.value).toEqual({ r: 252, g: 252, b: 250 });
    now = 'rgb(41, 36, 42)';
    // Not yet: nothing said the theme moved.
    expect(fg.value).toEqual({ r: 252, g: 252, b: 250 });
    bumpThemeEpoch();
    expect(fg.value).toEqual({ r: 41, g: 36, b: 42 });
  });

  it('is null for a colour that resolves to nothing, without asking twice', () => {
    const spy = engineSays(() => 'rgba(0, 0, 0, 0)');
    expect(themeColor('var(--nope)')).toBeNull();
    expect(themeColor('var(--nope)')).toBeNull();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
