// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Deletions reaching the client over the socket (#1013): the live frame, the
// resume sync, and rows read back as deleted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useLinkPreview.js', () => ({
  primePreviews: vi.fn<(texts: unknown[], toggles: unknown) => void>(),
  previewRevision: { value: 0 },
}));

const sockets: FakeWebSocket[] = [];
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  constructor() {
    sockets.push(this);
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  close(): void {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  deliver(frame: Record<string, unknown>): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(frame) });
  }
}

import { useSocket, resetPreviewToggleWiring, resetSocket } from './useSocket.js';
import { useRedactionsStore } from '../stores/redactions.js';
import { useBuffersStore } from '../stores/buffers.js';

const RouteView = defineComponent({
  setup() {
    useSocket();
    return () => null;
  },
});

const T = '2026-11-05T00:00:00.000Z';

describe('redaction frames', () => {
  beforeEach(() => {
    resetSocket();
    sockets.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
    setActivePinia(createPinia());
    resetPreviewToggleWiring();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetPreviewToggleWiring();
  });

  it('marks a line deleted from the live frame', async () => {
    mount(RouteView);
    await nextTick();
    sockets.at(-1)!.deliver({
      kind: 'message-redacted',
      networkId: 1,
      bufferId: 9,
      target: '#chan',
      messageId: 5,
      by: 'bob',
      reason: 'typo',
      self: false,
      time: T,
    });
    expect(useRedactionsStore().get({ id: 5 })).toEqual({ by: 'bob', reason: 'typo', time: T });
  });

  it('takes the deletions a reactions sync names', async () => {
    mount(RouteView);
    await nextTick();
    sockets.at(-1)!.deliver({
      kind: 'reactions-sync',
      messageIds: [5, 6],
      reactions: {},
      redactions: { '6': { by: 'opal', time: T } },
    });
    expect(useRedactionsStore().get({ id: 5 })).toBeUndefined();
    expect(useRedactionsStore().get({ id: 6 })).toEqual({ by: 'opal', time: T });
  });

  it('notes rows read back as deleted', async () => {
    mount(RouteView);
    await nextTick();
    useBuffersStore().ensure(1, '#chan', 9);
    sockets.at(-1)!.deliver({
      kind: 'history',
      networkId: 1,
      target: '#chan',
      mode: 'before',
      events: [
        {
          id: 7,
          networkId: 1,
          target: '#chan',
          type: 'message',
          nick: 'bob',
          text: null,
          time: T,
          redaction: { by: 'bob', time: T },
        },
        {
          id: 8,
          networkId: 1,
          target: '#chan',
          type: 'message',
          nick: 'bob',
          text: 'kept',
          time: T,
        },
      ],
    });
    expect(useRedactionsStore().get({ id: 7 })).toEqual({ by: 'bob', time: T });
    expect(useRedactionsStore().get({ id: 8 })).toBeUndefined();
  });
});
