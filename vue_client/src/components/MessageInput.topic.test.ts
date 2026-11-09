// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// /topic and /channel through the real composer (#1270): bare /topic asks the
// server (which answers in the channel), and /channel opens Channel Settings.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { socketSend } from '../composables/useSocket.js';
import { useChannelModal } from '../composables/useChannelModal.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<never> | null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let mounted: VueWrapper[] = [];

function channel(target: string, extra: Record<string, unknown> = {}) {
  return { networkId: 7, target, members: [], messages: [], joined: true, ...extra };
}

function seed(active = '7::#chan') {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 7, name: 'testnet' }] as never;
  networks.states = { 7: { nick: 'me' } } as never;
  buffers.buffers['7::#chan'] = channel('#chan') as never;
  buffers.buffers['7::&local'] = channel('&local') as never;
  buffers.buffers['7::#parted'] = channel('#parted', { joined: false }) as never;
  buffers.buffers['7::bob'] = { networkId: 7, target: 'bob', members: [], messages: [] } as never;
  networks.activeKey = active;
  useRecentBuffersStore().keys = [active];
}

// A channel name that completes is typed with the space completion leaves
// behind it: without one, Enter takes the suggestion instead of sending.
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

const said = (key: string) =>
  useBuffersStore().buffers[key].messages.map((m) => (m as { text?: string }).text);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(socketSend).mockClear();
  useChannelModal().close();
});
afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount();
  mounted = [];
});

describe('/topic', () => {
  it('asks the server, which answers in the channel, and prints nothing itself', async () => {
    seed();
    await run('/topic');
    expect(sent()).toEqual([{ type: 'raw', networkId: 7, line: 'TOPIC #chan' }]);
    expect(said('7::#chan')).toEqual([]);
  });

  it('asks about a named channel, from anywhere', async () => {
    seed('7::bob');
    await run('/topic #CHAN ');
    await run('/topic #elsewhere');
    expect(sent()).toEqual([
      { type: 'raw', networkId: 7, line: 'TOPIC #CHAN' },
      { type: 'raw', networkId: 7, line: 'TOPIC #elsewhere' },
    ]);
  });

  it('has no channel to ask about from a DM', async () => {
    seed('7::bob');
    await run('/topic');
    expect(sent()).toEqual([]);
    expect(said('7::bob')).toEqual(['usage: /topic [#chan] [text] — no channel context']);
  });

  it('still sets a topic', async () => {
    seed();
    await run('/topic new words here');
    await run('/topic &local over there');
    expect(sent()).toEqual([
      { type: 'raw', networkId: 7, line: 'TOPIC #chan :new words here' },
      { type: 'raw', networkId: 7, line: 'TOPIC &local :over there' },
    ]);
  });
});

describe('/channel', () => {
  it('opens Channel Settings for the current channel', async () => {
    seed();
    await run('/channel');
    expect(useChannelModal().current.value).toEqual({ networkId: 7, target: '#chan' });
  });

  it('opens it for a named channel, under the name the buffer has', async () => {
    seed('7::bob');
    await run('/chan &LOCAL ');
    expect(useChannelModal().current.value).toEqual({ networkId: 7, target: '&local' });
  });

  it('opens it for a channel we have parted but kept', async () => {
    seed();
    await run('/channel #parted ');
    expect(useChannelModal().current.value).toEqual({ networkId: 7, target: '#parted' });
  });

  it('has nothing to open from a DM', async () => {
    seed('7::bob');
    await run('/channel');
    expect(useChannelModal().current.value).toBeNull();
    expect(said('7::bob')).toEqual(['usage: /channel [#chan] — no channel context']);
  });

  it('refuses a channel with no buffer, and anything that is not a channel', async () => {
    seed();
    await run('/chan #elsewhere');
    await run('/channel bob');
    await run('/channel #chan extra');
    expect(useChannelModal().current.value).toBeNull();
    expect(said('7::#chan')).toEqual([
      "/chan: #elsewhere isn't open here.",
      'usage: /channel [#chan]',
      'usage: /channel [#chan]',
    ]);
  });
});
