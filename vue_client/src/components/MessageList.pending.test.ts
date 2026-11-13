// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A message of ours the network's send queue is holding (#1326) shows as our
// own row at the foot of its buffer, dimmed, until the server has it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;

const at = (minute: number) => new Date(Date.UTC(2026, 10, 13, 9, minute)).toISOString();

function enter() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = buffers.ensure(1, '#chan', 9);
  b.messages = [
    {
      id: 10,
      networkId: 1,
      bufferId: 9,
      target: '#chan',
      type: 'message',
      nick: 'peer',
      text: 'said before',
      userhost: 'peer!~u@host',
      time: at(1),
    },
  ] as never;
  b.joined = true;
  b.hasMoreOlder = false;
  buffers.ensure(1, '#other', 11);
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
  return { networks, buffers, w: wrapper };
}

const held = (id: string, target: string, text: string) => ({
  networkId: 1,
  id,
  target,
  kind: 'privmsg',
  text,
  at: at(2),
});

const pendingTexts = (w: VueWrapper) => w.findAll('.line.pending').map((el) => el.text());

describe('MessageList — a held message of ours', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('shows at the foot of its own buffer, dimmed, under the stored rows', async () => {
    const { networks, w } = enter();
    await w.vm.$nextTick();
    expect(w.findAll('.line.pending')).toHaveLength(0);
    // Whatever case the target was typed in; one for another buffer is not here.
    networks.applySendPending(held('a', '#CHAN', 'held one'));
    networks.applySendPending(held('b', '#other', 'elsewhere'));
    await w.vm.$nextTick();
    const pending = w.findAll('.line.pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].text()).toContain('held one');
    expect(pending[0].classes()).toContain('self');
    // No id: nothing to act on, anchor to, or count.
    expect(pending[0].attributes('data-msg-id')).toBeUndefined();
    const html = w.html();
    expect(html.indexOf('held one')).toBeGreaterThan(html.indexOf('said before'));
  });

  it('goes when the message does, leaving the stored row to say it', async () => {
    const { networks, buffers, w } = enter();
    networks.applySendPending(held('a', '#chan', 'held one'));
    await w.vm.$nextTick();
    expect(pendingTexts(w)).toHaveLength(1);
    buffers.pushMessage({
      id: 11,
      networkId: 1,
      bufferId: 9,
      target: '#chan',
      type: 'message',
      nick: 'me',
      text: 'held one',
      self: true,
      time: at(3),
    } as never);
    networks.applySendPendingDone({ networkId: 1, id: 'a', sent: true, rowFollows: false });
    await w.vm.$nextTick();
    expect(pendingTexts(w)).toHaveLength(0);
    expect(w.find('[data-msg-id="11"]').text()).toContain('held one');
  });
});
