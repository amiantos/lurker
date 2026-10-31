// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// An account held to one host, or an instance with one preset and no manual
// entry, has nothing to choose: the picker picks, and says it did so the parent
// can hide its way back. A list of one with a choice behind it stays a list.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import NetworkPicker from './NetworkPicker.vue';
import { useNetworkPresetsStore } from '../stores/networkPresets.js';
import { useAuthStore } from '../stores/auth.js';
import type { AccountRestrictions } from '../../../shared/accountRestrictions.js';

function setUp(opts: { allowUserDefined: boolean; restrictions?: AccountRestrictions }) {
  const presets = useNetworkPresetsStore();
  presets.presets = [];
  presets.allowUserDefined = opts.allowUserDefined;
  presets.loaded = true;
  presets.fetchAll = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const auth = useAuthStore();
  auth.user = { id: 1, username: 'held', role: 'user' } as NonNullable<typeof auth.user>;
  if (opts.restrictions) auth.setRestrictions(opts.restrictions);
}

beforeEach(() => setActivePinia(createPinia()));

describe('NetworkPicker auto-pick', () => {
  it('picks the one host an account is held to, marked as automatic', () => {
    setUp({
      allowUserDefined: true,
      restrictions: { networks: ['irc.lurker.chat'], uploads: true },
    });
    const wrapper = mount(NetworkPicker, { props: { autoPickSole: true } });
    const picks = wrapper.emitted('select') ?? [];
    expect(picks).toHaveLength(1);
    expect((picks[0][0] as { host: string }).host).toBe('irc.lurker.chat');
    expect(picks[0][1]).toBe(true);
  });

  it('shows the list when a choice remains', () => {
    // Unrestricted: the builtins and manual entry are all on offer.
    setUp({ allowUserDefined: true });
    const open = mount(NetworkPicker, { props: { autoPickSole: true } });
    expect(open.emitted('select')).toBeUndefined();
    // Two allowed hosts: a real list.
    setActivePinia(createPinia());
    setUp({
      allowUserDefined: true,
      restrictions: { networks: ['irc.lurker.chat', 'irc.libera.chat'], uploads: true },
    });
    const two = mount(NetworkPicker, { props: { autoPickSole: true } });
    expect(two.emitted('select')).toBeUndefined();
  });

  it('does nothing unless asked to', () => {
    setUp({
      allowUserDefined: true,
      restrictions: { networks: ['irc.lurker.chat'], uploads: true },
    });
    const wrapper = mount(NetworkPicker);
    expect(wrapper.emitted('select')).toBeUndefined();
  });
});
