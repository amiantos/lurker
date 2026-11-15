// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The body of a message we sent carries `own` (#1268), the hook the
// own-message colour reads. Text only: someone else's line, and our own
// action (whose body starts with our nick), are left alone.

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

function line(id: number, type: string, nick: string, self: boolean) {
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type,
    nick,
    self,
    text: `line ${id}`,
    time: new Date(Date.UTC(2026, 10, 14, 9, id)).toISOString(),
  };
}

const bodyOf = (id: number) => wrapper!.find(`[data-msg-id="${id}"] .body`);

describe('MessageList — own message text', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const networks = useNetworksStore();
    networks.networks = [{ id: 1, name: 'testnet' }] as never;
    networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
    const b = useBuffersStore().ensure(1, '#chan', 9);
    b.messages = [
      line(1, 'message', 'peer', false),
      line(2, 'message', 'me', true),
      line(3, 'action', 'me', true),
    ] as never;
    b.joined = true;
    b.hasMoreOlder = false;
    networks.activeKey = '1::#chan';
    wrapper = mount(MessageList, { attachTo: document.body });
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('marks the body of our own message, and nothing else', () => {
    expect(bodyOf(1).classes()).not.toContain('own');
    expect(bodyOf(2).classes()).toContain('own');
    expect(bodyOf(3).classes()).not.toContain('own');
  });
});
