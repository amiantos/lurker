// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import { useWindowsStore } from './windows.js';

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('open', () => {
  it('cascades new windows so a fresh one never lands exactly on the last', () => {
    const store = useWindowsStore();
    const a = store.open('1::#a');
    const b = store.open('1::#b');
    expect([b.x, b.y]).not.toEqual([a.x, a.y]);
  });

  it('focuses an existing window rather than opening a second for the same buffer', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.open('1::#b');
    expect(store.focusedKey).toBe('1::#b');

    store.open('1::#a');
    expect(store.windows).toHaveLength(2);
    expect(store.focusedKey).toBe('1::#a');
  });

  it('un-minimizes a minimized window', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.minimize('1::#a');
    expect(store.byKey('1::#a')?.state).toBe('minimized');

    store.open('1::#a');
    expect(store.byKey('1::#a')?.state).toBe('normal');
    expect(store.focusedKey).toBe('1::#a');
  });
});

describe('focusedKey', () => {
  it('is the highest-z window that is not minimized', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.open('1::#b');
    expect(store.focusedKey).toBe('1::#b');

    store.focus('1::#a');
    expect(store.focusedKey).toBe('1::#a');
  });

  it('skips minimized windows, so minimizing the top one hands focus down', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.open('1::#b');
    store.minimize('1::#b');
    expect(store.focusedKey).toBe('1::#a');
  });

  // The canvas keys "no active buffer" off this, which is what lets a sidebar
  // click on the same buffer re-open its window.
  it('is null when every window is minimized or closed', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.minimize('1::#a');
    expect(store.focusedKey).toBeNull();

    store.restore('1::#a');
    store.close('1::#a');
    expect(store.focusedKey).toBeNull();
  });
});

// The frames render at `calc(var(--z-window) + z)`. A monotonically increasing
// z would eventually cross --z-modal and paint windows over modals, so z must
// stay dense in 1..N no matter how much the user clicks around.
describe('z stays bounded by the window count', () => {
  it('does not grow with focus churn', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.open('1::#b');
    for (let i = 0; i < 50; i++) {
      store.focus(i % 2 === 0 ? '1::#a' : '1::#b');
    }
    expect(store.windows.map((w) => w.z).sort()).toEqual([1, 2]);
  });

  it('stays dense after a close', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.open('1::#b');
    store.open('1::#c');
    store.close('1::#b');
    expect(store.windows.map((w) => w.z)).toEqual([1, 2]);
  });

  it('orders z so the focused window is on top', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.open('1::#b');
    store.focus('1::#a');
    const a = store.byKey('1::#a')!;
    const b = store.byKey('1::#b')!;
    expect(a.z).toBeGreaterThan(b.z);
  });

  // The canvas renders a keyed v-for over `windows`. If focusing reordered the
  // array, Vue would move the frame's DOM node, and moving a node releases its
  // pointer capture — killing the drag that raised the window in the first
  // place. Stacking must live in z alone.
  it('never reorders the array, so the frame DOM node is not moved', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.open('1::#b');
    store.open('1::#c');
    const order = store.windows.map((w) => w.key);

    store.focus('1::#a');
    store.focus('1::#c');
    store.focus('1::#b');

    expect(store.windows.map((w) => w.key)).toEqual(order);
    expect(store.visible.map((w) => w.key)).toEqual(order);
  });
});

describe('resize', () => {
  it('clamps to the minimum size rather than inverting the frame', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.resize('1::#a', 10, 10);
    const win = store.byKey('1::#a')!;
    expect(win.w).toBeGreaterThan(10);
    expect(win.h).toBeGreaterThan(10);
  });

  it('is a no-op on a maximized window, which owns the canvas', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.toggleMaximize('1::#a');
    const before = { ...store.byKey('1::#a')! };
    store.resize('1::#a', 300, 300);
    store.move('1::#a', 50, 50);
    const after = store.byKey('1::#a')!;
    expect([after.w, after.h, after.x, after.y]).toEqual([before.w, before.h, before.x, before.y]);
  });
});

describe('toggleMaximize', () => {
  it('restores the pre-maximize geometry', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.move('1::#a', 40, 60);
    store.resize('1::#a', 500, 300);

    store.toggleMaximize('1::#a');
    expect(store.byKey('1::#a')?.state).toBe('maximized');

    store.toggleMaximize('1::#a');
    const win = store.byKey('1::#a')!;
    expect(win.state).toBe('normal');
    expect([win.x, win.y, win.w, win.h]).toEqual([40, 60, 500, 300]);
  });

  // Maximize is a state flag, not a geometry rewrite — the frame's inset comes
  // from CSS. So a round trip through any starting state leaves x/y/w/h intact.
  it('leaves geometry intact across a maximize round trip from minimized', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.move('1::#a', 40, 60);
    store.resize('1::#a', 500, 300);
    store.minimize('1::#a');

    store.toggleMaximize('1::#a');
    store.toggleMaximize('1::#a');
    const win = store.byKey('1::#a')!;
    expect([win.x, win.y, win.w, win.h]).toEqual([40, 60, 500, 300]);
  });
});

describe('clampTo', () => {
  it('keeps a grabbable strip of every window inside a shrunken canvas', () => {
    const store = useWindowsStore();
    store.open('1::#a');
    store.move('1::#a', 900, 700);

    store.clampTo(400, 300);
    const win = store.byKey('1::#a')!;
    expect(win.x).toBeLessThanOrEqual(400);
    expect(win.y).toBeLessThanOrEqual(300);
    expect(win.x).toBeGreaterThanOrEqual(0);
    expect(win.y).toBeGreaterThanOrEqual(0);
  });
});
