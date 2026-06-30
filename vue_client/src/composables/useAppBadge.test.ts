// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { ref, nextTick } from 'vue';

// Drive the badge watcher off a ref we control, without standing up the real
// buffers store (and its networks/socket graph). The getter reads the ref, so
// Vue tracks it reactively and the watcher fires on change. Declared before the
// import of useAppBadge so the hoisted mock closes over it; only read at
// call-time (inside a test), by when it's initialized.
const total = ref(0);
vi.mock('../stores/buffers.js', () => ({
  useBuffersStore: () => ({
    get totalHighlights() {
      return total.value;
    },
  }),
}));

import { startAppBadge, clearAppBadgeNow } from './useAppBadge.js';

let setAppBadge: Mock<(count?: number) => Promise<void>>;
let clearAppBadge: Mock<() => Promise<void>>;

// applyBadge reads the global `navigator` fresh on each call, so re-stubbing per
// test (with fresh spies) is enough — the long-lived watcher picks up whichever
// navigator is current when it fires. `{}` models a browser without the API.
function stubBadging(supported: boolean): void {
  setAppBadge = vi.fn<(count?: number) => Promise<void>>(() => Promise.resolve());
  clearAppBadge = vi.fn<() => Promise<void>>(() => Promise.resolve());
  vi.stubGlobal('navigator', supported ? { setAppBadge, clearAppBadge } : {});
}

beforeEach(() => stubBadging(true));
afterEach(() => vi.unstubAllGlobals());

describe('useAppBadge', () => {
  // Runs first, while the module's effect scope is still unwired, so the
  // unsupported branch of startAppBadge is exercised before any later test
  // starts the process-lifetime watcher.
  it('no-ops when the Badging API is unavailable', () => {
    stubBadging(false);
    expect(() => {
      startAppBadge();
      clearAppBadgeNow();
    }).not.toThrow();
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it('wires a watcher that sets the badge to the highlight total and clears at zero', async () => {
    total.value = 0;
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

  it('is idempotent — a second startAppBadge does not add a second watcher', async () => {
    startAppBadge(); // scope already wired by the previous test → no-op
    total.value = 7;
    await nextTick();
    // Exactly one watcher, so exactly one setAppBadge for the single change.
    expect(setAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).toHaveBeenLastCalledWith(7);
  });

  it('clearAppBadgeNow clears the badge', () => {
    clearAppBadgeNow();
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(setAppBadge).not.toHaveBeenCalled();
  });
});
