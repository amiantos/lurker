// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

let setAppBadge: Mock<(count?: number) => Promise<void>>;
let clearAppBadge: Mock<() => Promise<void>>;

beforeEach(() => {
  // Reset the module registry so each test gets a fresh useAppBadge with a fresh
  // module-level effect scope — no cross-test ordering dependency.
  vi.resetModules();
  setAppBadge = vi.fn<(count?: number) => Promise<void>>(() => Promise.resolve());
  clearAppBadge = vi.fn<() => Promise<void>>(() => Promise.resolve());
});

afterEach(() => vi.unstubAllGlobals());

// A minimal EventTarget stand-in — the suite runs in a node environment (no DOM),
// so we stub document/window like navigator. It records listeners and lets a test
// fire an event, without pulling in a DOM impl. A fresh one per load() means a
// listener registered in one test can never fire in another.
function makeEventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(type: string, fn: () => void) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

// Load a fresh useAppBadge wired to a ref we control. `vue` is imported AFTER the
// module reset and the ref is created from that same fresh instance, so the
// composable's `watch` (which imports the same post-reset `vue`) tracks it — a
// statically-imported ref would belong to a different reactivity instance and
// never trigger the watcher. `supported:false` models a browser without the API.
async function load(supported = true) {
  const { ref, nextTick } = await import('vue');
  const total = ref(0);
  vi.doMock('../stores/buffers.js', () => ({
    useBuffersStore: () => ({
      get totalHighlights() {
        return total.value;
      },
    }),
  }));
  vi.stubGlobal('navigator', supported ? { setAppBadge, clearAppBadge } : {});
  const doc = Object.assign(makeEventTarget(), { hidden: false });
  const win = makeEventTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  const mod = await import('./useAppBadge.js');
  return { ...mod, total, nextTick, doc, win };
}

describe('useAppBadge', () => {
  it('wires a watcher that sets the badge to the highlight total and clears at zero', async () => {
    const { startAppBadge, total, nextTick } = await load();
    startAppBadge();
    // immediate:true fires at the current total (0) → clear, not set.
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();

    total.value = 3;
    await nextTick();
    expect(setAppBadge).toHaveBeenLastCalledWith(3);

    total.value = 0;
    await nextTick();
    expect(clearAppBadge).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — repeated startAppBadge calls add only one watcher', async () => {
    const { startAppBadge, total, nextTick } = await load();
    startAppBadge();
    startAppBadge();
    startAppBadge();
    setAppBadge.mockClear(); // ignore the immediate fire from wiring
    total.value = 7;
    await nextTick();
    // Exactly one watcher → exactly one setAppBadge for the single change.
    expect(setAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).toHaveBeenLastCalledWith(7);
  });

  it('clearAppBadgeNow clears the badge', async () => {
    const { clearAppBadgeNow } = await load();
    clearAppBadgeNow();
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('re-clears the badge on return to visibility even when the total did not change (#463)', async () => {
    // The bug: the service worker sets the badge from a push while hidden, then
    // the app returns to the foreground with total still 0. The change-only
    // watcher never re-fires, so the stale SW-set count lingers. The visibility
    // reconcile must re-assert the store total (0 → clear) regardless of change.
    const { startAppBadge, nextTick, doc } = await load(); // total defaults to 0
    startAppBadge();
    await nextTick();
    clearAppBadge.mockClear();
    setAppBadge.mockClear();

    doc.fire('visibilitychange');
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('re-asserts a non-zero total on return to visibility', async () => {
    const { startAppBadge, total, nextTick, doc } = await load();
    total.value = 2;
    startAppBadge();
    await nextTick();
    setAppBadge.mockClear();
    clearAppBadge.mockClear();

    doc.fire('visibilitychange');
    expect(setAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).toHaveBeenLastCalledWith(2);
  });

  it('re-asserts the total on window focus (desktop PWA that never went hidden)', async () => {
    // A desktop window can regain the foreground via `focus` without ever having
    // been document.hidden (e.g. across OS sleep with the socket dropped), so
    // visibilitychange alone would miss it — the platform in the #463 report.
    const { startAppBadge, total, nextTick, win } = await load();
    total.value = 3;
    startAppBadge();
    await nextTick();
    setAppBadge.mockClear();

    win.fire('focus');
    expect(setAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).toHaveBeenLastCalledWith(3);
  });

  it('reconciles when visible but not while the page is hidden', async () => {
    const { startAppBadge, total, nextTick, doc } = await load();
    total.value = 4;
    startAppBadge();
    await nextTick();
    setAppBadge.mockClear();

    // Visible → the reconcile listener fires (proves it's actually wired).
    doc.fire('visibilitychange');
    expect(setAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).toHaveBeenLastCalledWith(4);

    // Hidden → the same event must NOT reconcile.
    setAppBadge.mockClear();
    doc.hidden = true;
    doc.fire('visibilitychange');
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it('no-ops when the Badging API is unavailable', async () => {
    const { startAppBadge, clearAppBadgeNow, total, nextTick } = await load(false);
    startAppBadge();
    clearAppBadgeNow();
    total.value = 5;
    await nextTick();
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });
});
