// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// #1464: a `settings` frame sent while this device was disconnected never
// arrived, so the connect snapshot restates the stored overrides. These drive
// real frames through the socket's message listener.

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
  readyState = 0;
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
  send(): void {}
  deliver(frame: Record<string, unknown>): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(frame) });
  }
}

import { useSocket, resetPreviewToggleWiring, resetSocket } from './useSocket.js';
import { useSettingsStore } from '../stores/settings.js';
import { useThemesStore } from '../stores/themes.js';

const KEY = 'look.title.buffer_names';

const RouteView = defineComponent({
  setup() {
    useSocket();
    return () => null;
  },
});

async function openSocket(): Promise<FakeWebSocket> {
  mount(RouteView);
  await nextTick();
  return sockets.at(-1)!;
}

const callsTo = (path: string) =>
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
    String(c[0]).endsWith(path),
  );
const bootstrapCalls = () => callsTo('/api/settings/bootstrap');

describe('settings on the connect snapshot', () => {
  beforeEach(() => {
    resetSocket(); // the socket is a module-level singleton
    sockets.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    // Applying a snapshot starts API fetches in other stores; settle them.
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

  it('takes the stored overrides from the snapshot, with no settings request', async () => {
    const settings = useSettingsStore();
    settings.loaded = true;
    const ws = await openSocket();
    ws.deliver({ kind: 'snapshot', networks: [], settings: { [KEY]: false } });
    expect(settings.effective(KEY)).toBe(false);
    expect(bootstrapCalls()).toHaveLength(0);
  });

  // Absence is an older server, not "no overrides".
  it('keeps what it holds when the snapshot carries no settings', async () => {
    const settings = useSettingsStore();
    settings.loaded = true;
    settings.values = { [KEY]: false };
    const ws = await openSocket();
    ws.deliver({ kind: 'snapshot', networks: [] });
    expect(settings.effective(KEY)).toBe(false);
  });

  // A boot fetch that failed left nothing loaded, and nothing else retries.
  it('asks for the bootstrap again when the boot fetch never landed', async () => {
    const settings = useSettingsStore();
    const ws = await openSocket();
    ws.deliver({ kind: 'snapshot', networks: [], settings: { [KEY]: false } });
    expect(bootstrapCalls()).toHaveLength(1);
    expect(settings.values).toEqual({});
    // Let the fetch land before teardown takes the fetch stub away: it goes on
    // to write the detected time zone.
    await vi.waitFor(() => expect(callsTo('/api/settings')).toHaveLength(1));
    await vi.waitFor(() => expect(settings.loading).toBeNull());
  });

  it('ignores a settings field that is not a map', async () => {
    const settings = useSettingsStore();
    settings.loaded = true;
    settings.values = { [KEY]: false };
    const ws = await openSocket();
    ws.deliver({ kind: 'snapshot', networks: [], settings: [] });
    expect(settings.values).toEqual({ [KEY]: false });
  });

  // A theme saved and applied elsewhere while this device was away: the
  // pointer and the theme it names arrive together, so nothing renders against
  // a theme still in flight.
  it('takes the saved themes from the snapshot, ahead of the pointer at one', async () => {
    const settings = useSettingsStore();
    settings.loaded = true;
    const themes = useThemesStore();
    const ws = await openSocket();
    ws.deliver({
      kind: 'snapshot',
      networks: [],
      themes: [{ id: 17, name: 'Elsewhere', values: {} }],
      settings: { 'look.theme.active': '17' },
    });
    expect(themes.byId('17')).toBeTruthy();
    expect(callsTo('/api/themes')).toHaveLength(0);
  });

  it('fetches the themes as before when the snapshot carries none', async () => {
    const ws = await openSocket();
    ws.deliver({ kind: 'snapshot', networks: [] });
    expect(callsTo('/api/themes')).toHaveLength(1);
  });
});
