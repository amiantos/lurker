// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// An unknown command's stored 421 raises a toast. When the server said it in
// the buffer the command was typed in instead (#816), that line lands in its
// buffer and raises none. Driven through the socket's message listener.

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
import { useToastsStore } from '../stores/toasts.js';

const RouteView = defineComponent({
  setup() {
    useSocket();
    return () => null;
  },
});

import { useBuffersStore } from '../stores/buffers.js';

describe('an unknown command', () => {
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

  const stored = (id: number) => ({
    kind: 'irc',
    type: 'error',
    id,
    networkId: 1,
    target: ':server:1',
    text: 'unknown_command FROB — Unknown command',
    unknownCommand: 'FROB',
  });
  const toasts = () => useToastsStore().items.filter((t) => t.title === 'Unknown command');

  it('raises the toast when the server said it nowhere else', async () => {
    mount(RouteView);
    await nextTick();
    sockets.at(-1)!.deliver(stored(10));
    expect(toasts()).toHaveLength(1);
  });

  it('shows the line in the buffer it was typed in, and no toast', async () => {
    mount(RouteView);
    await nextTick();
    const ws = sockets.at(-1)!;
    ws.deliver({
      kind: 'irc',
      type: 'error',
      networkId: 1,
      target: '#chan',
      text: 'FROB Unknown command',
    });

    expect(toasts()).toEqual([]);
    const lines = useBuffersStore().buffers['1::#chan']?.messages ?? [];
    expect(lines.map((m) => [m.type, m.text])).toEqual([['error', 'FROB Unknown command']]);
  });
});
