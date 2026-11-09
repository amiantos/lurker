// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// /topic and /channel through the real composer (#1270): bare /topic says the
// topic we hold for a channel we're in, and /channel opens Channel Settings.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { socketSend } from '../composables/useSocket.js';
import { useChannelModal } from '../composables/useChannelModal.js';
import { topicSetLine } from '../utils/topicMeta.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<never> | null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let mounted: VueWrapper[] = [];
const SET_AT = '2026-11-09T12:00:00.000Z';

function channel(target: string, extra: Record<string, unknown> = {}) {
  return { networkId: 7, target, members: [], messages: [], joined: true, ...extra };
}

function seed(active = '7::#chan') {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 7, name: 'testnet' }] as never;
  networks.states = { 7: { nick: 'me' } } as never;
  buffers.buffers['7::#chan'] = channel('#chan', {
    topic: 'Welcome | rules: be kind',
    topicSetBy: 'alice',
    topicSetAt: SET_AT,
  }) as never;
  buffers.buffers['7::&local'] = channel('&local', { topic: '' }) as never;
  buffers.buffers['7::#parted'] = channel('#parted', { joined: false, topic: 'stale' }) as never;
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
  it('says the held topic and who set it, and sends nothing', async () => {
    seed();
    await run('/topic');
    expect(said('7::#chan')).toEqual([
      'Topic for #chan: Welcome | rules: be kind',
      topicSetLine('alice', SET_AT),
    ]);
    expect(said('7::#chan')[1]).toMatch(/^Set by alice · /);
    expect(sent()).toEqual([]);
  });

  it('leaves the setter line out when the server never said', async () => {
    seed();
    Object.assign(useBuffersStore().buffers['7::#chan'], { topicSetBy: null, topicSetAt: null });
    await run('/topic');
    expect(said('7::#chan')).toEqual(['Topic for #chan: Welcome | rules: be kind']);
  });

  it('says so when there is no topic', async () => {
    seed('7::&local');
    await run('/topic');
    expect(said('7::&local')).toEqual(['No topic is set for &local.']);
    expect(sent()).toEqual([]);
  });

  it('answers for another joined channel in the buffer it was typed in', async () => {
    seed('7::bob');
    await run('/topic #CHAN ');
    expect(said('7::bob')[0]).toBe('Topic for #chan: Welcome | rules: be kind');
    expect(said('7::#chan')).toEqual([]);
    expect(sent()).toEqual([]);
  });

  it('asks the server about a channel we are not in', async () => {
    seed();
    await run('/topic #elsewhere');
    await run('/topic #parted ');
    expect(sent()).toEqual([
      { type: 'raw', networkId: 7, line: 'TOPIC #elsewhere' },
      { type: 'raw', networkId: 7, line: 'TOPIC #parted' },
    ]);
    expect(said('7::#chan')).toEqual([]);
  });

  it('still sets a topic', async () => {
    seed();
    await run('/topic new words here');
    await run('/topic &local over there');
    expect(sent()).toEqual([
      { type: 'raw', networkId: 7, line: 'TOPIC #chan :new words here' },
      { type: 'raw', networkId: 7, line: 'TOPIC &local :over there' },
    ]);
    expect(said('7::#chan')).toEqual([]);
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
