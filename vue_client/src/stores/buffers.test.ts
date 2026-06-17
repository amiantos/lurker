// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// buffers.ts reaches into the networks/toasts stores and the socket. applyReadState
// only consults useNetworksStore().activeKey, so a minimal mutable mock covers it;
// toasts/socket are stubbed so importing the store doesn't stand up the rest of the
// graph.
const h = vi.hoisted(() => ({ activeKey: null as string | null }));

vi.mock('./networks.js', () => ({
  useNetworksStore: () => ({
    get activeKey() {
      return h.activeKey;
    },
  }),
}));
vi.mock('./toasts.js', () => ({ useToastsStore: () => ({ push: vi.fn<() => void>() }) }));
vi.mock('../composables/useSocket.js', () => ({ socketSend: vi.fn<(payload: unknown) => void>() }));

import { useBuffersStore } from './buffers.js';

beforeEach(() => {
  setActivePinia(createPinia());
  h.activeKey = null;
});

describe('applyReadState', () => {
  // Regression for #319: mark-all-read fans out a read-state for every target
  // with history, including closed buffers (absent from the store). Applying
  // one must NOT materialize the buffer, or the closed buffer pops back into
  // the sidebar.
  it('does not create a buffer that is not open', () => {
    const store = useBuffersStore();
    expect(store.isOpen(1, '#closed')).toBe(false);

    store.applyReadState(1, '#closed', { lastReadId: 10, unread: 5, highlights: 2 });

    expect(store.isOpen(1, '#closed')).toBe(false);
    expect(store.list).toHaveLength(0);
  });

  it('updates the badge on an open buffer', () => {
    const store = useBuffersStore();
    // replaceBacklog ensures the buffer exists (the snapshot path), so this is
    // an "open" buffer.
    store.replaceBacklog(1, '#open', [], undefined, undefined, undefined);
    expect(store.isOpen(1, '#open')).toBe(true);

    store.applyReadState(1, '#open', { lastReadId: 42, unread: 3, highlights: 1 });

    const buf = store.byKey('1::#open')!;
    expect(buf.unread).toBe(3);
    expect(buf.highlighted).toBe(1);
    expect(buf.lastReadId).toBe(42);
  });

  it('suppresses the unread badge for the active buffer', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#here', [], undefined, undefined, undefined);
    h.activeKey = '1::#here';

    store.applyReadState(1, '#here', { lastReadId: 42, unread: 9, highlights: 4 });

    const buf = store.byKey('1::#here')!;
    expect(buf.unread).toBe(0);
    expect(buf.highlighted).toBe(0);
  });
});
