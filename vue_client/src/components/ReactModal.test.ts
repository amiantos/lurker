// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The react picker's free field: emoji suggestions for any word typed, colons
// optional, shown in the quick row's place (one row, never more than the quick
// picks), while Enter still sends the text as typed.

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

const row = (wrapper: ReturnType<typeof open>) =>
  wrapper.findAll('.quick .quick-btn').map((b) => b.text());
const QUICK = ['👍', '❤️', '😂', '🎉', '😮', '😢', '👀', '🙏'];

describe('ReactModal', () => {
  beforeAll(async () => {
    await loadEmoji();
  });
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
  });

  it('swaps the quick row for matches — a bare word or a :shortcode alike', async () => {
    const wrapper = open();
    expect(row(wrapper)).toEqual(QUICK);
    await type(wrapper, 'skul');
    expect(row(wrapper)).toContain('💀');
    expect(row(wrapper)).not.toContain('👍');
    await type(wrapper, ':skul');
    expect(row(wrapper)).toContain('💀');
    // One character is too little to search on: the quick picks come back.
    await type(wrapper, 's');
    expect(row(wrapper)).toEqual(QUICK);
    // Nothing below the field, ever.
    expect(wrapper.find('.suggestions').exists()).toBe(false);
    wrapper.unmount();
  });

  it('never shows more matches than the quick row holds', async () => {
    const wrapper = open();
    // `face` matches dozens.
    await type(wrapper, 'face');
    expect(row(wrapper).length).toBe(QUICK.length);
    // One button per glyph, even where aliases share one (`bee` / `honeybee`).
    await type(wrapper, 'bee');
    expect(row(wrapper).filter((e) => e === '🐝')).toHaveLength(1);
    expect(new Set(row(wrapper)).size).toBe(row(wrapper).length);
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
    const skull = wrapper.findAll('.quick .quick-btn').find((b) => b.text() === '💀')!;
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
