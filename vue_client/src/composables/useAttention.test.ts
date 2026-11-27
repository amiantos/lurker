// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let idleSeconds = 600;
vi.mock('../stores/settings.js', () => ({
  useSettingsStore: () => ({ effective: () => idleSeconds }),
}));

import {
  attentionSettingChanged,
  isAttended,
  onAttentionChange,
  resetAttentionForTests,
  startAttention,
} from './useAttention.js';

const MIN = 60_000;
let hidden = false;

function setHidden(value: boolean) {
  hidden = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

function input(type = 'keydown') {
  window.dispatchEvent(new Event(type));
}

describe('useAttention', () => {
  let changes: boolean[];

  beforeEach(() => {
    vi.useFakeTimers();
    idleSeconds = 600;
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    resetAttentionForTests();
    changes = [];
    startAttention();
    onAttentionChange((a) => changes.push(a));
  });

  afterEach(() => {
    resetAttentionForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts attended on a visible page', () => {
    expect(isAttended()).toBe(true);
  });

  it('goes unattended once the idle limit passes with no input', () => {
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(isAttended()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isAttended()).toBe(false);
    expect(changes).toEqual([false]);
  });

  it('counts the limit from the last input, not from the start', () => {
    vi.advanceTimersByTime(9 * MIN);
    input('pointermove');
    vi.advanceTimersByTime(9 * MIN);
    expect(isAttended()).toBe(true);
    vi.advanceTimersByTime(MIN);
    expect(isAttended()).toBe(false);
  });

  it.each(['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'])(
    'comes back on %s',
    (type) => {
      vi.advanceTimersByTime(10 * MIN);
      expect(isAttended()).toBe(false);
      input(type);
      expect(isAttended()).toBe(true);
      expect(changes).toEqual([false, true]);
    },
  );

  it('comes back on a scroll inside the page', () => {
    vi.advanceTimersByTime(10 * MIN);
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.dispatchEvent(new Event('scroll'));
    expect(isAttended()).toBe(true);
    el.remove();
  });

  it('is unattended at once when the page is hidden, and back when it shows', () => {
    setHidden(true);
    expect(isAttended()).toBe(false);
    // Hidden for longer than the limit: coming back is itself the input.
    vi.advanceTimersByTime(30 * MIN);
    setHidden(false);
    expect(isAttended()).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it('ignores input while hidden', () => {
    setHidden(true);
    input();
    expect(isAttended()).toBe(false);
  });

  it('never goes idle with the limit at 0', () => {
    idleSeconds = 0;
    attentionSettingChanged();
    vi.advanceTimersByTime(24 * 60 * MIN);
    expect(isAttended()).toBe(true);
    setHidden(true);
    expect(isAttended()).toBe(false);
  });

  it('re-times when the limit changes', () => {
    vi.advanceTimersByTime(2 * MIN);
    idleSeconds = 60;
    attentionSettingChanged();
    expect(isAttended()).toBe(false);
    idleSeconds = 600;
    attentionSettingChanged();
    expect(isAttended()).toBe(true);
  });

  it('stops telling a listener that unsubscribed', () => {
    const seen: boolean[] = [];
    const off = onAttentionChange((a) => seen.push(a));
    off();
    vi.advanceTimersByTime(10 * MIN);
    expect(seen).toEqual([]);
  });
});
