// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The quick switcher's query against network names (#1465), at the mounted
// component. switcherSort.test.ts covers the matching rules; this is that the
// switcher uses them, and lists name matches ahead of network matches.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import QuickSwitcher from './QuickSwitcher.vue';

let mounted: VueWrapper[] = [];

function seedStores() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [
    { id: 1, name: 'libera' },
    { id: 2, name: 'oftc' },
  ] as never;
  networks.states = { 1: { nick: 'me' }, 2: { nick: 'me' } } as never;
  const seed: [number, string][] = [
    [1, '#senpai'],
    [1, '#soju'],
    [2, '#libreoffice'],
    [2, '#debian'],
  ];
  for (const [networkId, target] of seed) {
    buffers.buffers[`${networkId}::${target}`] = {
      networkId,
      target,
      members: [],
      messages: [],
    } as never;
  }
  networks.activeKey = '2::#debian';
}

async function type(text: string) {
  const wrapper = mount(QuickSwitcher, { attachTo: document.body });
  mounted.push(wrapper);
  await wrapper.find('input.filter').setValue(text);
  return wrapper
    .findAll('li.row')
    .map((n) => `${n.find('.net').text()}/${n.find('.target').text()}`);
}

describe('QuickSwitcher query matches network names', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seedStores();
  });

  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('lists a network by its name, after the rows that match by their own name', async () => {
    expect(await type('lib')).toEqual([
      'oftc/#libreoffice',
      'libera/[server]',
      'libera/#senpai',
      'libera/#soju',
    ]);
  });

  it('narrows within a network with a second word', async () => {
    expect(await type('lib sen')).toEqual(['libera/#senpai']);
  });

  it('still finds a channel by name alone', async () => {
    expect(await type('soju')).toEqual(['libera/#soju']);
  });
});
