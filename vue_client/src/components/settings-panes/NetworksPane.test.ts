// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The pane keeps its own copy of the network list for the drag library to
// splice, refreshed from the store. The store adds a network with push() and
// replaces an edited one by index, both in place, and the refresh watched the
// array's identity: a network added or renamed from the pane's own buttons did
// not show in the list until Settings was reopened.

import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useNetworksStore, type Network } from '../../stores/networks.js';
import NetworksPane from './NetworksPane.vue';

const net = (id: number, name: string) =>
  ({ id, name, host: `irc.${name}.test`, blocked: false }) as unknown as Network;

const names = (w: VueWrapper) => w.findAll('.network .name').map((n) => n.text());

describe('NetworksPane', () => {
  let store: ReturnType<typeof useNetworksStore>;
  let wrapper: VueWrapper;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useNetworksStore();
    store.networks = [net(1, 'libera')];
    wrapper = mount(NetworksPane, {
      global: { stubs: { Teleport: true, RegistryPane: true, NetworkForm: true } },
    });
  });

  it('shows a network the store added in place', async () => {
    expect(names(wrapper)).toEqual(['libera']);
    store.networks.push(net(2, 'oftc'));
    await nextTick();
    expect(names(wrapper)).toEqual(['libera', 'oftc']);
  });

  it('shows an edited network the store replaced by index, and drops a removed one', async () => {
    store.networks[0] = net(1, 'libera-renamed');
    await nextTick();
    expect(names(wrapper)).toEqual(['libera-renamed']);
    store.networks.splice(0, 1);
    await nextTick();
    expect(names(wrapper)).toEqual([]);
  });

  it('opens the editor on the row that was clicked, and empty for add', async () => {
    store.networks.push(net(2, 'oftc'));
    await nextTick();
    await wrapper.findAll('.network .btn-bar button')[1].trigger('click');
    expect(wrapper.findComponent({ name: 'NetworkForm' }).props('network')).toMatchObject({
      id: 2,
    });
    await wrapper.findComponent({ name: 'NetworkForm' }).vm.$emit('close');
    await wrapper.find('.add-row button').trigger('click');
    expect(wrapper.findComponent({ name: 'NetworkForm' }).props('network')).toBeNull();
  });
});
