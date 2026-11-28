// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Folding at the mounted sidebar (#1432): a folded network opens while you
// are in it and folds when you leave, however you got in and wherever you go.
// utils/networkFold.test.ts covers the rules.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../composables/useSocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../composables/useSocket.js')>()),
  socketSend: vi.fn<() => boolean>(() => true),
}));

import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useFavoritesStore } from '../stores/favorites.js';
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts.js';
import BufferList from './BufferList.vue';

let wrapper: VueWrapper | null = null;

function rows(): string[] {
  return wrapper!.findAll('.net').map((n) => {
    const name = n.find('.net-head .name').text();
    const labels = n.findAll('.channels .label').map((l) => l.text());
    return `${name}: ${labels.join(' ')}`.trim();
  });
}

describe('BufferList folding', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const networks = useNetworksStore();
    const buffers = useBuffersStore();
    networks.networks = [
      { id: 1, name: 'alpha', collapsed: false },
      { id: 2, name: 'beta', collapsed: true },
      { id: 3, name: 'gamma', collapsed: false },
    ] as never;
    networks.states = {
      1: { state: 'connected' },
      2: { state: 'connected' },
      3: { state: 'connected' },
    } as never;
    for (const [networkId, target] of [
      [1, '#a1'],
      [1, '#a2'],
      [2, '#b1'],
      [2, '#b2'],
      [3, '#c1'],
      [3, '#c2'],
    ] as [number, string][]) {
      buffers.buffers[`${networkId}::${target}`] = {
        networkId,
        target,
        members: [],
        messages: [],
        unread: 0,
        highlighted: 0,
        joined: true,
      } as never;
    }
    buffers.activate = ((networkId: number, target: string) => {
      networks.activeKey = `${networkId}::${target}`;
    }) as never;
    networks.activeKey = '1::#a2';
    wrapper = mount(
      defineComponent({
        setup() {
          useKeyboardShortcuts();
          return () => h(BufferList);
        },
      }),
      { attachTo: document.body },
    );
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  const down = () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        code: 'ArrowDown',
        altKey: true,
        bubbles: true,
      }),
    );

  const up = () =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        code: 'ArrowUp',
        altKey: true,
        bubbles: true,
      }),
    );
  const clickRow = async (label: string) => {
    const el = wrapper!.findAll('.channels li').find((l) => l.text().includes(label))!;
    await el.trigger('click');
    await nextTick();
  };
  const clickHead = async (name: string) => {
    const el = wrapper!.findAll('.net-head').find((l) => l.text().includes(name))!;
    await el.trigger('click');
    await nextTick();
  };

  it('opens a folded network you step into, and folds it when you click into another', async () => {
    await nextTick();
    expect(rows()).toEqual(['LURKER:', 'alpha: #a1 #a2', 'beta:', 'gamma: #c1 #c2']);

    down();
    await nextTick();
    expect(rows()[2]).toBe('beta: #b1 #b2');

    await clickRow('#c1');
    expect(rows()[2]).toBe('beta:');
  });

  it('folds it when you go to the system buffer', async () => {
    down();
    await nextTick();
    expect(rows()[2]).toBe('beta: #b1 #b2');

    await clickHead('LURKER');
    expect(rows()[2]).toBe('beta:');
  });

  it('opens it for a click on its header, and folds it when you step out', async () => {
    await clickHead('beta');
    expect(rows()[2]).toBe('beta: #b1 #b2');
    up();
    await nextTick();
    expect(rows()[2]).toBe('beta:');
  });

  it('folds the network when the buffer you are in turns out to be a favorite', async () => {
    // Favorites arrive after the first buffer is active on a cold load.
    down();
    await nextTick();
    expect(rows()[2]).toBe('beta: #b1 #b2');

    useFavoritesStore().entries = [{ networkId: 2, target: '#b1' }] as never;
    await nextTick();
    // By name: the FAVORITES section now sits above the networks.
    expect(rows().find((r) => r.startsWith('beta'))).toBe('beta:');
  });
});

describe('BufferList with no-fold (the phone layout)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const networks = useNetworksStore();
    networks.networks = [{ id: 2, name: 'beta', collapsed: true }] as never;
    networks.states = { 2: { state: 'connected' } } as never;
    for (const target of ['#b1', '#b2']) {
      useBuffersStore().buffers[`2::${target}`] = {
        networkId: 2,
        target,
        members: [],
        messages: [],
        unread: 0,
        highlighted: 0,
        joined: true,
      } as never;
    }
    wrapper = mount(BufferList, { props: { noFold: true }, attachTo: document.body });
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('lists a folded network in full', () => {
    expect(rows()[1]).toBe('beta: #b1 #b2');
  });
});
