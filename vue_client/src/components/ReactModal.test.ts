// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The react picker's free field: emoji suggestions for any word typed, colons
// optional, while Enter still sends the text as typed.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { socketSend } from '../composables/useSocket.js';
import ReactModal from './ReactModal.vue';
import { useReactionsStore } from '../stores/reactions.js';
import { useNetworksStore } from '../stores/networks.js';
import { loadEmoji } from '../utils/emojiShortcodes.js';

const NET = 1;

function open() {
  useNetworksStore().states[NET] = {
    networkId: NET,
    channels: [],
    state: 'connected',
    canReact: true,
  };
  useReactionsStore().openPicker({ id: 10, networkId: NET, nick: 'bob', text: 'hi' });
  return mount(ReactModal, { attachTo: document.body });
}

async function type(wrapper: ReturnType<typeof open>, text: string) {
  const input = wrapper.find('input.typed');
  (input.element as HTMLInputElement).value = text;
  await input.trigger('input');
  await nextTick();
}

const suggested = (wrapper: ReturnType<typeof open>) =>
  wrapper.findAll('.suggestions .quick-btn').map((b) => b.text());

describe('ReactModal', () => {
  beforeAll(async () => {
    await loadEmoji();
  });
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
  });

  it('suggests emoji for a bare word, and for a :shortcode alike', async () => {
    const wrapper = open();
    await type(wrapper, 'skul');
    expect(suggested(wrapper)).toContain('💀');
    await type(wrapper, ':skul');
    expect(suggested(wrapper)).toContain('💀');
    // One character is too little to search on.
    await type(wrapper, 's');
    expect(suggested(wrapper)).toEqual([]);
    wrapper.unmount();
  });

  it('still sends what was typed on Enter, so text reactions work', async () => {
    const wrapper = open();
    await type(wrapper, 'lol');
    await wrapper.find('form').trigger('submit');
    expect(socketSend).toHaveBeenLastCalledWith({
      type: 'react',
      messageId: 10,
      value: 'lol',
      remove: false,
    });
    wrapper.unmount();
  });

  it('sends a picked suggestion', async () => {
    const wrapper = open();
    await type(wrapper, 'skul');
    const skull = wrapper.findAll('.suggestions .quick-btn').find((b) => b.text() === '💀')!;
    await skull.trigger('click');
    expect(socketSend).toHaveBeenLastCalledWith({
      type: 'react',
      messageId: 10,
      value: '💀',
      remove: false,
    });
    wrapper.unmount();
  });
});
