// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A consolidated summary opened in place (#1430), through the real
// MessageList: the chevron lists the run's events under the summary, the run
// stays open as it changes, and a jump onto a folded event opens its run.

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

function row(type: string, nick: string, extra: Record<string, unknown> = {}) {
  const id = nextId++;
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type,
    nick,
    text: type === 'message' ? 'hello' : '',
    userhost: `${nick}!~u@host`,
    time: new Date(Date.UTC(2026, 10, 27, 12, id)).toISOString(),
    self: false,
    ...extra,
  };
}

function mountWith(messages: Record<string, unknown>[]) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = buffers.ensure(1, '#chan', 9);
  b.messages = messages as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
  return { w: wrapper, b };
}

const shown = (w: VueWrapper, id: number) => w.find(`[data-msg-id="${id}"]`).exists();
const toggle = (w: VueWrapper) => w.find('.cons-toggle');
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

describe('MessageList — an opened summary', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    nextId = 1;
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('lists its events under it, and folds them again', async () => {
    const run = [row('join', 'alice'), row('quit', 'bob'), row('join', 'carol')];
    const { w } = mountWith([row('message', 'dave'), ...run]);
    expect(run.some((m) => shown(w, m.id))).toBe(false);
    expect(toggle(w).attributes('aria-expanded')).toBe('false');

    await toggle(w).trigger('click');
    expect(run.every((m) => shown(w, m.id))).toBe(true);
    // The summary stays, as the heading of what it folded.
    expect(w.find('[data-cons-first-id]').exists()).toBe(true);
    expect(toggle(w).attributes('aria-expanded')).toBe('true');

    await toggle(w).trigger('click');
    expect(run.some((m) => shown(w, m.id))).toBe(false);
  });

  it('gives a lone event no chevron', () => {
    const { w } = mountWith([row('message', 'dave'), row('join', 'alice')]);
    expect(toggle(w).exists()).toBe(false);
  });

  it('stays open as the run gains an event and loses its first', async () => {
    const run = [row('join', 'alice'), row('quit', 'bob'), row('join', 'carol')];
    const { w, b } = mountWith(run);
    await toggle(w).trigger('click');

    const late = row('join', 'erin');
    // The buffer's cap evicts the oldest row as a live one lands.
    b.messages = [...run.slice(1), late] as never;
    await w.vm.$nextTick();
    expect(shown(w, run[0].id)).toBe(false);
    expect([run[1], run[2], late].every((m) => shown(w, m.id))).toBe(true);
  });

  it('stays open when every event it was opened with is gone', async () => {
    const run = [row('join', 'alice'), row('quit', 'bob')];
    const { w, b } = mountWith(run);
    await toggle(w).trigger('click');

    const late = [row('join', 'carol'), row('join', 'erin')];
    b.messages = [...run, ...late] as never;
    await w.vm.$nextTick();
    b.messages = late as never;
    await w.vm.$nextTick();
    expect(late.every((m) => shown(w, m.id))).toBe(true);
  });

  it('closed, stays closed when an evicted event of it is loaded again', async () => {
    const run = [row('join', 'alice'), row('quit', 'bob'), row('join', 'carol')];
    const { w, b } = mountWith(run);
    await toggle(w).trigger('click');
    b.messages = run.slice(1) as never;
    await w.vm.$nextTick();
    await toggle(w).trigger('click');
    expect(run.some((m) => shown(w, m.id))).toBe(false);

    // An older page brings the evicted row back.
    b.messages = run as never;
    await w.vm.$nextTick();
    expect(run.some((m) => shown(w, m.id))).toBe(false);
  });

  it('opens for a jump onto an event it folded', async () => {
    const run = [row('join', 'alice'), row('quit', 'bob'), row('join', 'carol')];
    const { w } = mountWith([row('message', 'dave'), ...run]);
    await w.setProps({ pendingScrollId: run[1].id });
    await w.vm.$nextTick();
    await frame();
    await w.vm.$nextTick();
    expect(run.every((m) => shown(w, m.id))).toBe(true);
  });
});
