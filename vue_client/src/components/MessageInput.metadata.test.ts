// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// /avatar, /displayname and /metadata through the real composer (#1189):
// connected, the line goes out (the server saves it from the answer); not
// connected, or on a network that can't carry it, it's refused here.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { socketSend } from '../composables/useSocket.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<never> | null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const apiCalls: Array<{ url: string; method?: string; body?: unknown }> = [];
vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  api: (url: string, opts: { method?: string; body?: unknown } = {}) => {
    apiCalls.push({ url, ...opts });
    return Promise.resolve({ values: {}, unset: [], live: null, avatarPreview: null });
  },
}));

const LIMITS = { maxSubs: 10, maxKeys: 10, maxValueBytes: null, beforeConnect: false };
let mounted: VueWrapper[] = [];

function seed(state: Record<string, unknown>) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 7, name: 'testnet' }] as never;
  networks.states = { 7: { nick: 'me', ...state } } as never;
  buffers.buffers['7::#chan'] = {
    networkId: 7,
    target: '#chan',
    members: [],
    messages: [],
  } as never;
  networks.activeKey = '7::#chan';
  useRecentBuffersStore().keys = ['7::#chan'];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function run(command: string) {
  const wrapper = mount(MessageInput, { attachTo: document.body });
  mounted.push(wrapper);
  await flush();
  const el = wrapper.find('textarea').element as HTMLTextAreaElement;
  el.value = command;
  el.setSelectionRange(command.length, command.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
}

const sent = () =>
  vi
    .mocked(socketSend)
    .mock.calls.map(([payload]) => payload as Record<string, unknown>)
    .filter((p) => p.type === 'raw');

const said = () =>
  (useBuffersStore().buffers['7::#chan'].messages as Array<{ text?: string }>).map((m) => m.text);

describe('our own metadata commands', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    apiCalls.length = 0;
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('sends the line on a connected network that carries it', async () => {
    seed({ state: 'connected', metadataLimits: LIMITS });
    await run('/displayname Me Myself');
    expect(sent()).toEqual([
      {
        type: 'raw',
        networkId: 7,
        issuingTarget: '#chan',
        line: 'METADATA * SET display-name :Me Myself',
      },
    ]);
    expect(apiCalls).toEqual([]);
  });

  it('refuses on a network that is not connected', async () => {
    seed({ state: 'disconnected' });
    await run('/avatar https://example.org/me.png');
    expect(sent()).toEqual([]);
    expect(apiCalls).toEqual([]);
    expect(said().at(-1)).toBe('/avatar: not connected.');
  });

  it("reads someone's metadata on a network with no room for ours (soju)", async () => {
    seed({ state: 'connected', metadataLimits: { ...LIMITS, maxKeys: 0 } });
    await run('/metadata list alice');
    expect(sent()).toEqual([
      { type: 'raw', networkId: 7, issuingTarget: '#chan', line: 'METADATA alice LIST' },
    ]);
  });

  it("refuses on a connected network that can't carry it", async () => {
    seed({ state: 'connected', metadataLimits: null });
    await run('/avatar off');
    expect(sent()).toEqual([]);
    expect(apiCalls).toEqual([]);
    expect(said().at(-1)).toBe("/avatar: this network doesn't support IRCv3 metadata.");
  });
});
