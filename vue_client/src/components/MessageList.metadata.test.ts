// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What a row shows of its author's metadata beyond the avatar: the time on
// their clock in the timestamp's tooltip (#1450), their colour fitted to the
// palette (#1452), and whatever the user set on them over all of it (#1449).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNickMetadataStore } from '../stores/nickMetadata.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;
const PALETTE = ['#e02020', '#20e020', '#2020e0'];

function message(id: number, nick: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick,
    text: `line ${id}`,
    // A Wednesday; 14:00 in Berlin (summer time).
    time: '2026-07-01T12:00:00.000Z',
    ...extra,
  };
}

function mountChat(userMetadata: Record<string, unknown>) {
  useSettingsStore().values = { 'look.nick.colors': PALETTE } as never;
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = {
    1: { nick: 'me', state: 'connected', peerPresence: {}, userMetadata },
  } as never;
  const b = useBuffersStore().ensure(1, '#chan', 9);
  b.members = [];
  b.messages = [message(1, 'bob'), message(2, 'carol'), message(3, 'me', { self: true })] as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
}

const row = (id: number) => wrapper!.find(`[data-msg-id="${id}"]`);
const timeTitle = (id: number) => row(id).find('.time').attributes('title');
const nickColour = (id: number) =>
  (row(id).find('.prefix .nick-ref').element as HTMLElement).style.color;

describe('MessageList — author metadata', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it("puts the line's time on its author's clock in the tooltip, where a zone is known", () => {
    mountChat({ bob: { tz: 'Europe/Berlin' }, me: { tz: 'Asia/Tokyo' } });
    expect(timeTitle(1)).toMatch(/^bob's time: Wed.*14:00 \(Europe\/Berlin\)$/);
    expect(timeTitle(2)).toBeUndefined();
    // Not on our own lines: we know what time it was.
    expect(timeTitle(3)).toBeUndefined();
  });

  it('takes a zone the user set on someone, on a network with no metadata', async () => {
    mountChat({});
    expect(timeTitle(2)).toBeUndefined();
    useNickMetadataStore().applyUpdate(1, 'carol', { 'lurker.chat/tz': 'America/New_York' });
    await nextTick();
    expect(timeTitle(2)).toMatch(/^carol's time: Wed.*08:00 \(America\/New_York\)$/);
  });

  it('paints a published colour fitted to the palette, and a picked slot over it', async () => {
    mountChat({ bob: { color: '#00ff10' } });
    const shown = nickColour(1);
    expect(shown).toMatch(/^#[0-9a-f]{6}$/);
    expect(shown).not.toBe('#00ff10');
    useNickMetadataStore().applyUpdate(1, 'bob', { color: '2' });
    await nextTick();
    expect(nickColour(1)).toBe(PALETTE[2]);
  });
});
