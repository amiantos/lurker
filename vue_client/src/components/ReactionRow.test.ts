// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The chip row under a message: a chip per value with its count, ours marked,
// a click that toggles only when the network can carry it, and a + chip that
// opens the picker.

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
    expect(wrapper.find('.reaction-row').exists()).toBe(false);
  });

  it('shows a chip per value with its count, first-reacted first, names in the tooltip', () => {
    const wrapper = withReactions([r('alice', '👍'), r('carol', '👍'), r('dave', '🎉')]);
    const chips = wrapper.findAll('.chip:not(.add)');
    expect(chips.map((c) => [c.find('.value').text(), c.find('.count').text()])).toEqual([
      ['👍', '2'],
      ['🎉', '1'],
    ]);
    expect(chips[0].attributes('title')).toBe('alice, carol reacted 👍');
  });

  it('marks a reaction that is ours, and toggles it on click', async () => {
    const wrapper = withReactions([r('alice', 'lol'), r('me', 'lol', true), r('bob', '🎉')]);
    const [lol, party] = wrapper.findAll('.chip:not(.add)');
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
    await wrapper.find('.chip:not(.add)').trigger('click');
    expect(socketSend).not.toHaveBeenCalled();
  });

  // A notice or an encrypted line can show reactions others sent, but the
  // server won't let us send one there — so no dead buttons.
  it('is read-only on a line we can’t react to', async () => {
    useReactionsStore().noteFromEvents([{ id: 10, reactions: [r('alice', '👍')] }], NET);
    useNetworksStore().states[NET] = {
      networkId: NET,
      channels: [],
      state: 'connected',
      canReact: true,
    };
    const wrapper = mount(ReactionRow, { props: { message, interactive: false } });
    expect(wrapper.find('.chip.add').exists()).toBe(false);
    await wrapper.find('.chip').trigger('click');
    expect(socketSend).not.toHaveBeenCalled();
  });

  it('opens the picker from the + chip', async () => {
    const wrapper = withReactions([r('alice', '👍')]);
    await wrapper.find('.chip.add').trigger('click');
    expect(useReactionsStore().picker).toMatchObject({ open: true, messageId: 10, networkId: NET });
  });
});
