// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// buffers.ts reaches into the networks/toasts stores and the socket. The actions
// under test only consult useNetworksStore().activeKey and setActive(), so a
// minimal mutable mock covers it; toasts/socket are stubbed so importing the
// store doesn't stand up the rest of the graph.
const h = vi.hoisted(() => ({ activeKey: null as string | null }));

vi.mock('./networks.js', () => ({
  useNetworksStore: () => ({
    get activeKey() {
      return h.activeKey;
    },
    set activeKey(v: string | null) {
      h.activeKey = v;
    },
    // Mirrors the real store: activeKey = `${networkId}::${target}`.
    setActive(networkId: number | string, target: string) {
      h.activeKey = `${networkId}::${target}`;
    },
  }),
}));
vi.mock('./toasts.js', () => ({ useToastsStore: () => ({ push: vi.fn<() => void>() }) }));
vi.mock('../composables/useSocket.js', () => ({ socketSend: vi.fn<(payload: unknown) => void>() }));

import { useBuffersStore } from './buffers.js';
import { socketSend } from '../composables/useSocket.js';

// The store always seeds the app-scoped system buffer (#355). These tests assert
// on network-buffer counts (fork/removal semantics), so filter it out.
const netBuffers = (store: ReturnType<typeof useBuffersStore>) =>
  store.list.filter((b) => b.networkId != null);

beforeEach(() => {
  setActivePinia(createPinia());
  h.activeKey = null;
  vi.mocked(socketSend).mockClear();
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
    expect(netBuffers(store)).toHaveLength(0);
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

  // Servers hand us inconsistently-cased channel/nick names (#289). A read-state
  // broadcast whose target case differs from the buffer's stored key must still
  // resolve to the open buffer (findByTarget), not silently drop the badge or
  // fork a phantom lowercase entry.
  it('updates a buffer opened under a different target case', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#Chan', [], undefined, undefined, undefined);
    expect(store.isOpen(1, '#Chan')).toBe(true);

    store.applyReadState(1, '#chan', { lastReadId: 7, unread: 4, highlights: 1 });

    const buf = store.byKey('1::#Chan')!;
    expect(buf.unread).toBe(4);
    expect(buf.highlighted).toBe(1);
    expect(buf.lastReadId).toBe(7);
    expect(store.byKey('1::#chan')).toBeNull(); // no phantom lowercase entry
    expect(netBuffers(store)).toHaveLength(1);
  });

  // While a buffer is active its unread divider is pinned (dividerAfterId set on
  // activate); a late read-state carrying a lower lastReadId must not slide the
  // divider backward out from under the reader (the Math.max branch).
  it('does not move lastReadId backwards while the divider is pinned', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#pinned', [], undefined, undefined, undefined);
    const buf = store.byKey('1::#pinned')!;
    buf.dividerAfterId = 100;
    buf.lastReadId = 50;

    store.applyReadState(1, '#pinned', { lastReadId: 30, unread: 0, highlights: 0 });
    expect(buf.lastReadId).toBe(50);

    store.applyReadState(1, '#pinned', { lastReadId: 70, unread: 0, highlights: 0 });
    expect(buf.lastReadId).toBe(70);
  });
});

// Regression for #327: IRC targets are case-insensitive but buffer identity used
// to key by exact case, so a live DM (or a member-list/`/query` activation)
// arriving under a different nick-case than the open buffer forked a duplicate.
// ensureBuffer/activate/isOpen/drop now fold case via resolveExistingKey, so
// every write, the active-buffer pointer, the open/closed guard, and the close
// all resolve to the single canonical (first-seen) buffer. "No fork" is asserted
// with the exact-key byKey() (which stays a key primitive), since isOpen() now
// correctly reports the canonical buffer as open under any casing.
describe('case-insensitive buffer identity (#327)', () => {
  const dm = (target: string, id: number, nick = target) => ({
    networkId: 1,
    target,
    id,
    type: 'message',
    nick,
    body: 'x',
  });

  it('appends a live DM under a divergent nick-case to the existing buffer', () => {
    const store = useBuffersStore();
    store.pushMessage(dm('Bob', 1));
    expect(store.isOpen(1, 'Bob')).toBe(true);

    // Same peer, server-relayed under a different casing — must land in the open
    // buffer rather than fork a second `bob` entry.
    const fresh = store.pushMessage(dm('bob', 2));
    expect(fresh).toBe(true);

    expect(netBuffers(store)).toHaveLength(1);
    expect(store.byKey('1::Bob')!.messages).toHaveLength(2);
    expect(store.byKey('1::bob')).toBeNull(); // no lowercase fork
  });

  it('records a speaker under a divergent case without forking a buffer', () => {
    const store = useBuffersStore();
    store.pushMessage(dm('Bob', 1));

    // recordSpeaker is the sibling side effect fired right after pushMessage in
    // the socket handler; it funnels through ensureBuffer too, so it must not
    // fork its own lowercase shell.
    store.recordSpeaker(1, 'bob', 'bob', 1000);

    expect(netBuffers(store)).toHaveLength(1);
    expect(store.byKey('1::bob')).toBeNull(); // no lowercase fork
    expect(store.byKey('1::Bob')!.speakers['bob']).toBeTruthy();
  });

  it('keeps live read-sync on the active buffer when the inbound DM case diverges', () => {
    const store = useBuffersStore();
    store.pushMessage(dm('Bob', 1));
    h.activeKey = '1::Bob';

    store.pushMessage(dm('bob', 2));

    // The read pointer advances and a mark-read goes out under the buffer's
    // canonical target, even though the event arrived as `bob`.
    expect(store.byKey('1::Bob')!.lastReadId).toBe(2);
    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mark-read', networkId: 1, target: 'Bob', messageId: 2 }),
    );
  });

  it('activates the existing buffer under a divergent case and keeps activeKey canonical', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, 'Bob', [dm('Bob', 5)], undefined, undefined, undefined);
    expect(store.isOpen(1, 'Bob')).toBe(true);

    store.activate(1, 'bob');

    // activeKey must point at the key the buffer is actually stored under, or
    // useActiveBuffer's byKey(activeKey) returns null and blanks the chat view.
    expect(h.activeKey).toBe('1::Bob');
    expect(store.byKey(h.activeKey!)).toBeTruthy();
    expect(netBuffers(store)).toHaveLength(1);
    expect(store.byKey('1::bob')).toBeNull(); // no lowercase fork
  });

  it('isOpen resolves a buffer open under a divergent case (toast/jump focus guard)', () => {
    const store = useBuffersStore();
    store.pushMessage(dm('Bob', 1));

    // ToastContainer/useJumpToMessage gate activate() on isOpen() with the raw
    // server-cased target (highlight toast → event.target, friend-online →
    // event.nick). Folding keeps a live buffer from being reported "closed" and
    // refusing to focus its own notification — the regression the read-path
    // fold otherwise introduces by merging the fork away.
    expect(store.isOpen(1, 'bob')).toBe(true);
    expect(store.isOpen(1, 'BOB')).toBe(true);
    expect(store.byKey('1::bob')).toBeNull(); // still one canonical buffer
  });

  it('drop removes the buffer when the close target case diverges', () => {
    const store = useBuffersStore();
    store.pushMessage(dm('Bob', 1));
    expect(netBuffers(store)).toHaveLength(1);

    // The server doesn't canonicalize DM casing, so a buffer-closed broadcast
    // can carry a different case than the stored buffer; an exact-key delete
    // would leave a sidebar ghost.
    store.drop(1, 'bob');

    expect(netBuffers(store)).toHaveLength(0);
    expect(store.isOpen(1, 'Bob')).toBe(false);
  });

  it('setJoined resolves a divergently-cased channel target', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#Chan', [], undefined, undefined, true);
    const buf = store.byKey('1::#Chan')!;
    expect(buf.joined).toBe(true);

    store.setJoined(1, '#chan', false);

    expect(buf.joined).toBe(false);
    expect(netBuffers(store)).toHaveLength(1);
  });
});

// Feeds the PWA app-icon badge (#451). The sum must track each buffer's
// server-owned `highlighted` count and inherit applyReadState's active-buffer
// suppression, so the focused conversation never inflates the badge.
describe('totalHighlights', () => {
  it('is zero with only the seeded system buffer', () => {
    const store = useBuffersStore();
    expect(store.totalHighlights).toBe(0);
  });

  it('sums highlighted across open buffers', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#a', [], undefined, undefined, undefined);
    store.replaceBacklog(1, '#b', [], undefined, undefined, undefined);
    store.applyReadState(1, '#a', { lastReadId: 0, unread: 5, highlights: 2 });
    store.applyReadState(1, '#b', { lastReadId: 0, unread: 9, highlights: 3 });

    expect(store.totalHighlights).toBe(5);
  });

  it('excludes the active buffer, whose highlighted is forced to 0', () => {
    const store = useBuffersStore();
    store.replaceBacklog(1, '#a', [], undefined, undefined, undefined);
    store.replaceBacklog(1, '#b', [], undefined, undefined, undefined);
    // User is sitting in #a, so its read-state echo is suppressed to 0.
    h.activeKey = '1::#a';
    store.applyReadState(1, '#a', { lastReadId: 0, unread: 5, highlights: 2 });
    store.applyReadState(1, '#b', { lastReadId: 0, unread: 9, highlights: 3 });

    expect(store.byKey('1::#a')!.highlighted).toBe(0);
    expect(store.totalHighlights).toBe(3);
  });
});
