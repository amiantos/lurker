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

// A pointer that really moved: each call lands somewhere new on the screen.
let pointerX = 0;
function movePointer(to = (pointerX += 5)) {
  window.dispatchEvent(new MouseEvent('pointermove', { screenX: to, screenY: 100 }));
}

function input(type = 'keydown') {
  if (type === 'pointermove') movePointer();
  else window.dispatchEvent(new Event(type));
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
    // The pointer is somewhere already, so the next move has a "before".
    movePointer(0);
    pointerX = 0;
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

  // A new line scrolls the list to the tail and slides rows under a parked
  // pointer. The browser reports both; neither is anyone being here.
  it('stays unattended through a scroll and a pointermove that went nowhere', () => {
    vi.advanceTimersByTime(10 * MIN);
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.dispatchEvent(new Event('scroll'));
    movePointer(pointerX);
    movePointer(pointerX);
    expect(isAttended()).toBe(false);
    el.remove();
  });

  it('does not let a stream of them hold off idle either', () => {
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(MIN);
      document.dispatchEvent(new Event('scroll'));
      movePointer(pointerX);
    }
    expect(isAttended()).toBe(false);
  });

  it('does not count the first pointermove it ever sees', () => {
    resetAttentionForTests();
    startAttention();
    vi.advanceTimersByTime(10 * MIN);
    movePointer(40);
    expect(isAttended()).toBe(false);
    movePointer(45);
    expect(isAttended()).toBe(true);
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

  it('goes unattended when the limit drops below the time already idle', () => {
    vi.advanceTimersByTime(2 * MIN);
    idleSeconds = 60;
    attentionSettingChanged();
    expect(isAttended()).toBe(false);
    expect(changes).toEqual([false]);
  });

  // The setting can arrive from another device while nobody is at this one.
  it('does not come back because the limit was raised', () => {
    vi.advanceTimersByTime(10 * MIN);
    idleSeconds = 3600;
    attentionSettingChanged();
    expect(isAttended()).toBe(false);
    expect(changes).toEqual([false]);
    input();
    expect(isAttended()).toBe(true);
  });

  it('survives a limit longer than a timer can hold', () => {
    idleSeconds = 30 * 24 * 3600;
    attentionSettingChanged();
    vi.advanceTimersByTime(60 * MIN);
    expect(isAttended()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  // A laptop that slept: the clock jumped, the idle timer never fired.
  it('answers from the clock when its timer is behind, and reports both changes', () => {
    vi.setSystemTime(Date.now() + 8 * 60 * MIN);
    expect(isAttended()).toBe(false);
    expect(changes).toEqual([]);
    input();
    expect(isAttended()).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it('stops telling a listener that unsubscribed', () => {
    const seen: boolean[] = [];
    const off = onAttentionChange((a) => seen.push(a));
    off();
    vi.advanceTimersByTime(10 * MIN);
    expect(seen).toEqual([]);
  });
});
