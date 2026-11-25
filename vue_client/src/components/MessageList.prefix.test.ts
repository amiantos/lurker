// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The speaker's mode glyph in the message list follows the network's PREFIX
// (#1032).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;

function glyphFor(
  prefix: { mode: string; symbol: string }[] | null,
  settings: Record<string, unknown> = {},
) {
  useSettingsStore().values = { 'look.nick.show_mode_prefix': true, ...settings } as never;
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = {
    1: {
      nick: 'me',
      state: 'connected',
      peerPresence: {},
      modeSpec: prefix ? { prefix } : null,
    },
  } as never;
  const b = useBuffersStore().ensure(1, '#chan', 9);
  b.members = [{ nick: 'yan', modes: ['Y'], away: false }];
  b.messages = [
    {
      id: 1,
      networkId: 1,
      bufferId: 9,
      target: '#chan',
      type: 'message',
      nick: 'yan',
      text: 'hi',
      time: new Date(Date.UTC(2026, 9, 5, 12)).toISOString(),
    },
  ] as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
  return wrapper.find('[data-msg-id="1"] .mode-glyph');
}

describe('MessageList — PREFIX glyph', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it("marks the speaker with the network's symbol", () => {
    const glyph = glyphFor([
      { mode: 'Y', symbol: '!' },
      { mode: 'o', symbol: '@' },
    ]);
    expect(glyph.text()).toBe('!');
    expect(glyph.classes()).toContain('mode-owner');
  });

  it('leaves the rank colour off when the glyph takes the nick colour (#1403)', () => {
    const glyph = glyphFor([{ mode: 'Y', symbol: '!' }], {
      'look.nick.mode_prefix_nick_color': true,
    });
    expect(glyph.text()).toBe('!');
    expect(glyph.classes()).toEqual(['mode-glyph']);
  });

  it('shows no glyph for a letter the conventional table lacks, before ISUPPORT', () => {
    expect(glyphFor(null).exists()).toBe(false);
  });
});
