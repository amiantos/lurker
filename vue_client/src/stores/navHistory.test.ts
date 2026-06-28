// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// navHistory dispatches hops through the buffers/friends stores. Stub both: byKey
// reports liveness from a Set, activate echoes its key back through record() the
// way the real activeKey watcher does (so the re-entrancy guard is exercised),
// and friends.open() echoes the :friends: sentinel. ':friends:' is inlined here
// because vi.hoisted runs before the virtualBuffers import binding exists.
const h = vi.hoisted(() => ({
  live: new Set<string>(),
  record: null as null | ((key: string) => void),
  activate: vi.fn((networkId: number | null, target: string) => {
    h.record?.(networkId == null ? target : `${networkId}::${target}`);
  }),
  friendsOpen: vi.fn(() => h.record?.(':friends:')),
}));

vi.mock('./buffers.js', () => ({
  useBuffersStore: () => ({
    byKey: (k: string) => (h.live.has(k) ? { key: k } : null),
    activate: h.activate,
  }),
}));
vi.mock('./friends.js', () => ({
  useFriendsStore: () => ({ open: h.friendsOpen }),
}));

import { useNavHistoryStore } from './navHistory.js';
import { FRIENDS_KEY, SYSTEM_KEY } from '../lib/virtualBuffers.js';

// Create the store and wire the simulated activeKey watcher (activate/open echo
// back into record), matching how useKeyboardShortcuts hooks it up live.
function mkStore() {
  const nav = useNavHistoryStore();
  h.record = (k) => nav.record(k);
  return nav;
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.live.clear();
  h.record = null;
  h.activate.mockReset();
  h.activate.mockImplementation((networkId: number | null, target: string) => {
    h.record?.(networkId == null ? target : `${networkId}::${target}`);
  });
  h.friendsOpen.mockReset();
  h.friendsOpen.mockImplementation(() => h.record?.(':friends:'));
});

describe('record', () => {
  it('builds the stack and tracks back/forward reachability', () => {
    const nav = mkStore();
    nav.record('1::#a');
    expect(nav.canBack).toBe(false);
    nav.record('1::#b');
    expect(nav.stack).toEqual(['1::#a', '1::#b']);
    expect(nav.index).toBe(1);
    expect(nav.canBack).toBe(true);
    expect(nav.canForward).toBe(false);
  });
});

describe('back / forward dispatch', () => {
  it('back re-activates the previous network buffer with parsed network + target', () => {
    const nav = mkStore();
    h.live.add('1::#a').add('1::#b');
    nav.record('1::#a');
    nav.record('1::#b');
    h.activate.mockClear();

    nav.back();

    expect(h.activate).toHaveBeenCalledWith(1, '#a');
    expect(nav.index).toBe(0);
    expect(nav.canForward).toBe(true);
  });

  it('forward returns to the buffer we backed away from', () => {
    const nav = mkStore();
    h.live.add('1::#a').add('1::#b');
    nav.record('1::#a');
    nav.record('1::#b');
    nav.back();
    h.activate.mockClear();

    nav.forward();

    expect(h.activate).toHaveBeenCalledWith(1, '#b');
    expect(nav.index).toBe(1);
  });

  it('routes the system sentinel to the networkId-less system buffer', () => {
    const nav = mkStore();
    h.live.add('1::#a');
    nav.record(SYSTEM_KEY);
    nav.record('1::#a');
    h.activate.mockClear();

    nav.back();

    expect(h.activate).toHaveBeenCalledWith(null, SYSTEM_KEY);
  });

  it('routes the friends sentinel through the friends store', () => {
    const nav = mkStore();
    h.live.add('1::#a');
    nav.record(FRIENDS_KEY);
    nav.record('1::#a');

    nav.back();

    expect(h.friendsOpen).toHaveBeenCalledOnce();
    expect(h.activate).not.toHaveBeenCalled();
  });

  it('skips a buffer that was closed since it was visited', () => {
    const nav = mkStore();
    h.live.add('1::#a').add('1::#c'); // #dead is gone from the store
    nav.record('1::#a');
    nav.record('1::#dead');
    nav.record('1::#c');
    h.activate.mockClear();

    nav.back(); // over #dead, onto #a

    expect(h.activate).toHaveBeenCalledOnce();
    expect(h.activate).toHaveBeenCalledWith(1, '#a');
    expect(nav.index).toBe(0);
  });

  it('no-ops at the back boundary without activating anything', () => {
    const nav = mkStore();
    h.live.add('1::#a');
    nav.record('1::#a');
    h.activate.mockClear();

    nav.back();

    expect(h.activate).not.toHaveBeenCalled();
    expect(nav.index).toBe(0);
  });
});

describe('re-entrancy guard', () => {
  it('ignores the activation echo so a back hop cannot corrupt the stack', () => {
    const nav = mkStore();
    h.live.add('1::#a').add('1::#b');
    nav.record('1::#a');
    nav.record('1::#b');
    // Simulate the activeKey watcher echoing a *canonicalized* (differently
    // cased) key back into record() mid-hop. The dedupe check wouldn't catch a
    // different string — only the navigating guard keeps the stack intact.
    h.activate.mockImplementation(() => nav.record('1::#CANON'));

    nav.back();

    expect(nav.stack).toEqual(['1::#a', '1::#b']);
    expect(nav.index).toBe(0);
  });
});
