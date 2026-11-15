// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// "Channels to join" on a new network (#1338) sits with the basics, as it
// does in first-run onboarding, not under Advanced. Editing has no such
// field: a saved network's channels are its buffers.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { useNetworkPresetsStore } from '../stores/networkPresets.js';
import type { Network } from '../stores/networks.js';
import NetworkForm from './NetworkForm.vue';
import NetworkPicker from './NetworkPicker.vue';

let mounted: ReturnType<typeof mount>[] = [];

function open(props: Record<string, unknown> = {}) {
  const form = mount(NetworkForm, { props });
  mounted.push(form);
  return form;
}

// A new network opens on the picker; "manual" is the way to the bare form.
async function openManual() {
  const form = open();
  form.findComponent(NetworkPicker).vm.$emit('manual');
  await form.vm.$nextTick();
  return form;
}

const channelsLabel = (form: ReturnType<typeof mount>) =>
  form.findAll('label').find((l) => l.text().startsWith('Channels to join'));

describe('NetworkForm — channels to join', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(useNetworkPresetsStore(), 'fetchAll').mockResolvedValue(undefined);
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('shows on a new network with Advanced still closed', async () => {
    const form = await openManual();
    expect(form.find('.advanced').exists()).toBe(false);
    const label = channelsLabel(form);
    expect(label).toBeDefined();
    expect(label!.find('input').exists()).toBe(true);
  });

  it('stays out of Advanced once that is opened', async () => {
    const form = await openManual();
    const toggle = form.findAll('button').find((b) => b.text().startsWith('+ Advanced options'))!;
    await toggle.trigger('click');
    expect(form.find('.advanced').text()).not.toContain('Channels to join');
    expect(
      form.findAll('label').filter((l) => l.text().startsWith('Channels to join')),
    ).toHaveLength(1);
  });

  it('is not offered when editing a saved network', () => {
    const network = {
      id: 7,
      name: 'Libera',
      host: 'irc.libera.chat',
      port: 6697,
      nick: 'nick',
      tls: true,
      autoconnect: true,
      trusted_certificates: true,
    } as Network;
    expect(channelsLabel(open({ network }))).toBeUndefined();
  });
});
