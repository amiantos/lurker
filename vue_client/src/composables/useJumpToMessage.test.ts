// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ref, nextTick } from 'vue';

// Mirror buffers.test.ts: the store reaches into networks/toasts/socket. Keep a
// stable toast spy so the closed-buffer notice is assertable, and make socketSend
// report success so loadAround mints a token instead of bailing.
const h = vi.hoisted(() => ({ activeKey: null as string | null, push: vi.fn<() => void>() }));

vi.mock('../stores/networks.js', () => ({
  useNetworksStore: () => ({
    get activeKey() {
      return h.activeKey;
    },
    set activeKey(v: string | null) {
      h.activeKey = v;
    },
    setActive(networkId: number | string, target: string) {
      h.activeKey = `${networkId}::${target}`;
    },
  }),
}));
vi.mock('../stores/toasts.js', () => ({ useToastsStore: () => ({ push: h.push }) }));
vi.mock('./useSocket.js', () => ({ socketSend: vi.fn<() => boolean>(() => true) }));

import { useBuffersStore } from '../stores/buffers.js';
import { useJumpToMessage } from './useJumpToMessage.js';

const NET = 1;

beforeEach(() => {
  setActivePinia(createPinia());
  h.activeKey = null;
  h.push.mockClear();
});

describe('useJumpToMessage', () => {
  it('arms pendingScrollId immediately when the message is already in memory', () => {
    const store = useBuffersStore();
    const buf = store.ensure(NET, '#chan');
    buf.messages.push({ id: 5, networkId: NET, target: '#chan', type: 'message' } as any);

    const pendingScrollId = ref<number | null>(null);
    const jump = useJumpToMessage({ pendingScrollId });
    jump({ networkId: NET, target: '#chan', messageId: 5 });

    expect(pendingScrollId.value).toBe(5);
  });

  it('re-arms for a repeat jump to the same id by bouncing through null', async () => {
    const store = useBuffersStore();
    const buf = store.ensure(NET, '#chan');
    buf.messages.push({ id: 5, networkId: NET, target: '#chan', type: 'message' } as any);

    const pendingScrollId = ref<number | null>(null);
    const jump = useJumpToMessage({ pendingScrollId });
    jump({ networkId: NET, target: '#chan', messageId: 5 });
    expect(pendingScrollId.value).toBe(5);

    // Same id again would be a no-op for MessageList's watcher without the bounce.
    jump({ networkId: NET, target: '#chan', messageId: 5 });
    expect(pendingScrollId.value).toBe(null);
    await nextTick();
    expect(pendingScrollId.value).toBe(5);
  });

  it('arms after the around-slice lands when the message is off-screen (not by length)', async () => {
    const store = useBuffersStore();
    store.ensure(NET, '#chan'); // open but empty — target message is not in memory

    const pendingScrollId = ref<number | null>(null);
    const jump = useJumpToMessage({ pendingScrollId });
    jump({ networkId: NET, target: '#chan', messageId: 100 });

    // Not armed yet — we're waiting on the history fetch to settle.
    expect(pendingScrollId.value).toBe(null);
    const buf = store.findByTarget(NET, '#chan')!;
    expect(buf.loadingHistory).toBe(true);

    // Land the slice via the real token the store minted.
    store.applyAroundSlice(NET, '#chan', {
      token: buf.pendingHistoryToken,
      events: [{ id: 100, networkId: NET, target: '#chan', type: 'message' }],
      hasMoreOlder: false,
      hasMoreNewer: false,
    });
    await nextTick();

    expect(pendingScrollId.value).toBe(100);
  });

  it('is not disarmed by a concurrent older-history pager (token-keyed, not loadingHistory)', async () => {
    const store = useBuffersStore();
    store.ensure(NET, '#chan');

    const pendingScrollId = ref<number | null>(null);
    const jump = useJumpToMessage({ pendingScrollId });
    jump({ networkId: NET, target: '#chan', messageId: 100 });

    const buf = store.findByTarget(NET, '#chan')!;
    const token = buf.pendingHistoryToken;

    // An in-flight loadOlder response lands first: prependHistory clears
    // loadingHistory with NO token guard, but leaves pendingHistoryToken alone.
    // A loadingHistory watch would have stopped here and lost the jump.
    store.prependHistory(
      NET,
      '#chan',
      [{ id: 5, networkId: NET, target: '#chan', type: 'message' } as any],
      false,
      undefined,
    );
    await nextTick();
    expect(pendingScrollId.value).toBe(null);

    // Our around-slice finally lands (token match) and arms.
    store.applyAroundSlice(NET, '#chan', {
      token,
      events: [{ id: 100, networkId: NET, target: '#chan', type: 'message' }],
      hasMoreOlder: false,
      hasMoreNewer: false,
    });
    await nextTick();
    expect(pendingScrollId.value).toBe(100);
  });

  it('does not arm a same-length slice that omits the target (superseded jump)', async () => {
    const store = useBuffersStore();
    store.ensure(NET, '#chan');

    const pendingScrollId = ref<number | null>(null);
    const jump = useJumpToMessage({ pendingScrollId });
    jump({ networkId: NET, target: '#chan', messageId: 100 });

    const buf = store.findByTarget(NET, '#chan')!;
    // A slice that settles loadingHistory but lacks message 100 must not scroll.
    store.applyAroundSlice(NET, '#chan', {
      token: buf.pendingHistoryToken,
      events: [{ id: 7, networkId: NET, target: '#chan', type: 'message' }],
      hasMoreOlder: false,
      hasMoreNewer: false,
    });
    await nextTick();

    expect(pendingScrollId.value).toBe(null);
  });

  it('shows a "Buffer is closed" notice instead of jumping into a closed buffer', () => {
    const pendingScrollId = ref<number | null>(null);
    const jump = useJumpToMessage({ pendingScrollId });
    jump({ networkId: NET, target: '#never-opened', messageId: 9 });

    expect(pendingScrollId.value).toBe(null);
    expect(h.push).toHaveBeenCalledWith(expect.objectContaining({ title: 'Buffer is closed' }));
  });
});
