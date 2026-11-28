// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The traditional layout's nick column (#1405): as wide as the widest nick
// drawn, and grow-only while a buffer is open. happy-dom lays nothing out, so
// the grid's resolved tracks are stubbed; what is under test is what the list
// does with them.

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
let nextId = 1;
// What the stubbed layout reports. (The list is a multi-root component, so
// its scroller is found by class, not taken as the wrapper's element.)
let tracks = '';
let fontSize = '14px';

function line(nick: string, target = '#chan', bufferId = 9) {
  const id = nextId++;
  return {
    id,
    networkId: 1,
    bufferId,
    target,
    type: 'message',
    nick,
    text: 'hello',
    time: new Date(Date.UTC(2026, 10, 28, 12, id)).toISOString(),
    self: false,
  };
}

function open(target: string, bufferId: number, messages: Record<string, unknown>[]) {
  const b = useBuffersStore().ensure(1, target, bufferId);
  b.messages = messages as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  useNetworksStore().activeKey = `1::${target}`;
  return b;
}

const floor = (w: VueWrapper) =>
  (w.find('.message-list').element as HTMLElement).style.getPropertyValue('--nick-col-floor');

describe('MessageList — the nick column', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    nextId = 1;
    tracks = '60px 80px 400px';
    fontSize = '14px';
    const real = globalThis.getComputedStyle.bind(globalThis);
    vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((el: Element) => {
      const cs = real(el);
      if (!el.classList.contains('message-list')) return cs;
      return new Proxy(cs, {
        get: (target, prop) =>
          prop === 'gridTemplateColumns'
            ? tracks
            : prop === 'fontSize'
              ? fontSize
              : Reflect.get(target, prop),
      });
    });
    const networks = useNetworksStore();
    networks.networks = [{ id: 1, name: 'testnet' }] as never;
    networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
  });

  it('keeps the widest the column has been, and never less', async () => {
    const b = open('#chan', 9, [line('bob')]);
    const w = (wrapper = mount(MessageList, { attachTo: document.body }));
    await w.vm.$nextTick();
    expect(floor(w)).toBe('80px');

    tracks = '60px 140px 340px';
    b.messages = [...b.messages, line('averylongnickname')] as never;
    await w.vm.$nextTick();
    expect(floor(w)).toBe('140px');

    // The wide nick's row is gone; the column stays.
    tracks = '60px 80px 400px';
    b.messages = [...b.messages.slice(0, 1), line('carol')] as never;
    await w.vm.$nextTick();
    expect(floor(w)).toBe('140px');
  });

  it('starts over in another buffer', async () => {
    open('#chan', 9, [line('averylongnickname')]);
    tracks = '60px 140px 340px';
    const w = (wrapper = mount(MessageList, { attachTo: document.body }));
    await w.vm.$nextTick();
    expect(floor(w)).toBe('140px');

    tracks = '60px 50px 430px';
    open('#other', 10, [line('al', '#other', 10)]);
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(floor(w)).toBe('50px');
  });

  // A reader scrolled up: the row at the top of their view is `anchor`, and
  // `top` is where the stubbed layout says it sits, asked at each read.
  async function scrolledUpAt(w: VueWrapper, anchorId: number, top: () => number) {
    const scroller = w.find('.message-list');
    const el = scroller.element as HTMLElement;
    const anchor = w.find(`[data-msg-id="${anchorId}"]`).element as HTMLElement;
    Object.defineProperty(anchor, 'offsetTop', { get: top, configurable: true });
    document.elementFromPoint = () => anchor;
    el.scrollTop = 40;
    await scroller.trigger('wheel', { deltaY: -10 });
    return el;
  }

  it('holds a scrolled-up reader in place when an append moves their row', async () => {
    const b = open('#chan', 9, [line('bob'), line('carol')]);
    const w = (wrapper = mount(MessageList, { attachTo: document.body }));
    await w.vm.$nextTick();
    // Once the wider nick's row is drawn, the lines above have rewrapped and
    // the reader's row is 30px further down.
    const wide = line('averylongnickname');
    const drawn = () => w.find(`[data-msg-id="${wide.id}"]`).exists();
    const el = await scrolledUpAt(w, 2, () => (drawn() ? 130 : 100));

    b.messages = [...b.messages, wide] as never;
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(el.scrollTop).toBe(70);
  });

  it('leaves the scroll position unwritten when the row did not move', async () => {
    const b = open('#chan', 9, [line('bob'), line('carol')]);
    const w = (wrapper = mount(MessageList, { attachTo: document.body }));
    await w.vm.$nextTick();
    const el = await scrolledUpAt(w, 2, () => 100);
    let writes = 0;
    let scrollTop = 40;
    Object.defineProperty(el, 'scrollTop', {
      get: () => scrollTop,
      set: (v: number) => {
        writes += 1;
        scrollTop = v;
      },
      configurable: true,
    });

    b.messages = [...b.messages, line('al')] as never;
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(writes).toBe(0);
  });

  it('measures again when the font changes', async () => {
    const b = open('#chan', 9, [line('bob')]);
    const w = (wrapper = mount(MessageList, { attachTo: document.body }));
    await w.vm.$nextTick();
    expect(floor(w)).toBe('80px');

    fontSize = '10px';
    tracks = '45px 60px 435px';
    b.messages = [...b.messages, line('carol')] as never;
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    await w.vm.$nextTick();
    expect(floor(w)).toBe('60px');
  });
});
