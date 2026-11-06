// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A gap filled from the network's history (#1283) is stored after the rejoin
// it precedes: the JOIN row lands at the join, the page's lines seconds later
// with fresh ids. Shown by id they sat under the join; shown by time they sit
// where they were said, with the unread divider above the first of them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { setUnreadDividerShown } from '../lib/unreadDivider.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;

const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 9, minute)).toISOString();

const line = (id: number, minute: number, text: string, replay = false) => ({
  id,
  networkId: 1,
  bufferId: 9,
  target: '#chan',
  type: 'message',
  nick: 'peer',
  text,
  userhost: 'peer!~u@host',
  time: at(minute),
  ...(replay ? { replay: true } : {}),
});

const join = (id: number, minute: number) => ({
  id,
  networkId: 1,
  bufferId: 9,
  target: '#chan',
  type: 'join',
  nick: 'me',
  userhost: 'me!~u@host',
  time: at(minute),
});

function enter() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = buffers.ensure(1, '#chan', 9);
  // Read through the line before the drop; the rejoin's own JOIN is past
  // the boundary, so the divider is on screen when the page lands (a line
  // landing with no boundary shown moves the boundary to the tail instead:
  // the reader is looking, so it is read, replayed or not).
  b.messages = [line(10, 18, 'before'), join(20, 22)] as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.dividerAfterId = 10;
  b.lastReadId = 10;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
  return { buffers, w: wrapper };
}

const shownIds = (w: VueWrapper) =>
  w.findAll('[data-msg-id]').map((el) => Number(el.attributes('data-msg-id')));

describe('MessageList — a filled gap is shown where it was said', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setUnreadDividerShown('1::#chan', null);
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('places the replayed lines under the line they followed, not under the join', async () => {
    const { buffers, w } = enter();
    await w.vm.$nextTick();
    expect(shownIds(w)).toEqual([10, 20]);
    // The page arrives: two lines from the gap, then a live one.
    buffers.pushMessage(line(21, 19, 'gap one', true) as never);
    buffers.pushMessage(line(22, 20, 'gap two', true) as never);
    buffers.pushMessage(line(23, 23, 'after') as never);
    await w.vm.$nextTick();
    expect(shownIds(w)).toEqual([10, 21, 22, 20, 23]);
    // The store keeps the order it was stored in: that is what pages.
    expect(buffers.byKey('1::#chan')!.messages.map((m) => m.id)).toEqual([10, 20, 21, 22, 23]);
    // The unread divider sits above the first unread row on screen, the
    // gap's first line, and the read join shows under it.
    const html = w.html();
    const divider = html.indexOf('unread-divider');
    expect(divider).toBeGreaterThan(html.indexOf('data-msg-id="10"'));
    expect(divider).toBeLessThan(html.indexOf('data-msg-id="21"'));
  });
});
