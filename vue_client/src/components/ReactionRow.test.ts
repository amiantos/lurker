// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The reaction line under a message: names while they fit, a count past three,
// ours marked, and a click that toggles only when the network can carry it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { socketSend } from '../composables/useSocket.js';
import ReactionRow from './ReactionRow.vue';
import { useReactionsStore } from '../stores/reactions.js';
import { useNetworksStore } from '../stores/networks.js';
import type { MessageReaction } from '../../../shared/reactions.js';

const NET = 1;
const message = { id: 10, networkId: NET, nick: 'bob', text: 'hi' };

function withReactions(reactions: MessageReaction[], connected = true) {
  useReactionsStore().noteFromEvents([{ id: 10, reactions }], NET);
  useNetworksStore().states[NET] = {
    networkId: NET,
    channels: [],
    state: connected ? 'connected' : 'disconnected',
    canReact: true,
  };
  return mount(ReactionRow, { props: { message } });
}

const r = (nick: string, value: string, self = false): MessageReaction => ({ nick, value, self });

describe('ReactionRow', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
  });

  it('renders nothing on a line nobody reacted to', () => {
    const wrapper = withReactions([]);
    expect(wrapper.find('.reaction-line').exists()).toBe(false);
  });

  it('names up to three people per reaction, then shows a count', () => {
    const wrapper = withReactions([
      r('alice', '👍'),
      r('carol', '👍'),
      r('d1', '👀'),
      r('d2', '👀'),
      r('d3', '👀'),
      r('d4', '👀'),
    ]);
    const groups = wrapper.findAll('.group');
    expect(groups.map((g) => g.find('.value').text())).toEqual(['👍', '👀']);
    expect(groups[0].findAll('.nick').map((n) => n.text())).toEqual(['alice', 'carol']);
    expect(groups[1].find('.nick').exists()).toBe(false);
    expect(groups[1].find('.count').text()).toBe('4');
    // Everyone is still in the tooltip.
    expect(groups[1].attributes('title')).toBe('d1, d2, d3, d4 reacted 👀');
  });

  it('marks a reaction that is ours, and toggles it on click', async () => {
    const wrapper = withReactions([r('alice', 'lol'), r('me', 'lol', true), r('bob', '🎉')]);
    const [lol, party] = wrapper.findAll('.value');
    expect(lol.classes()).toContain('mine');
    expect(party.classes()).not.toContain('mine');
    await lol.trigger('click');
    expect(socketSend).toHaveBeenLastCalledWith({
      type: 'react',
      messageId: 10,
      value: 'lol',
      remove: true,
    });
    await party.trigger('click');
    expect(socketSend).toHaveBeenLastCalledWith({
      type: 'react',
      messageId: 10,
      value: '🎉',
      remove: false,
    });
  });

  it('sends nothing while the network is down', async () => {
    const wrapper = withReactions([r('alice', '👍')], false);
    await wrapper.find('.value').trigger('click');
    expect(socketSend).not.toHaveBeenCalled();
  });
});
