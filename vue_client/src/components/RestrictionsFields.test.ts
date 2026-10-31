// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The one editor for a restriction set, shared by the Users and Invites panes.
// The trap it exists to avoid: an empty host box read as "any network", which
// would widen an account whose list is deliberately empty on an unrelated
// save. Mount it and drive the controls.

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import RestrictionsFields from './RestrictionsFields.vue';
import type { AccountRestrictions } from '../../../shared/accountRestrictions.js';

// Mounted the way a parent uses it, as a v-model: each emission becomes the
// next prop, so a control that depends on the model (the host box under "any
// network") sees the change the way it would in the pane.
function mountWith(modelValue: AccountRestrictions) {
  const wrapper = mount(RestrictionsFields, {
    props: {
      modelValue,
      'onUpdate:modelValue': (v: AccountRestrictions) => wrapper.setProps({ modelValue: v }),
    },
  });
  const emitted = () =>
    (wrapper.emitted('update:modelValue') ?? []).map((e) => e[0] as AccountRestrictions);
  const checks = () => wrapper.findAll('input[type="checkbox"]');
  const hosts = () => wrapper.find('input:not([type="checkbox"])');
  return { wrapper, emitted, checks, hosts };
}

describe('RestrictionsFields', () => {
  it('shows an empty list as "none", not as "any"', () => {
    const { checks, hosts } = mountWith({ networks: [], uploads: true });
    expect((checks()[0].element as HTMLInputElement).checked).toBe(false);
    expect(hosts().attributes('placeholder')).toBe('none');
    expect(hosts().attributes('disabled')).toBeUndefined();
  });

  it('disables the host box under "any network" and emits null for it', async () => {
    const { checks, emitted } = mountWith({ networks: ['irc.lurker.chat'], uploads: true });
    await checks()[0].setValue(true);
    expect(emitted().at(-1)).toStrictEqual({ networks: null, uploads: true });
    const { hosts: hostsAny } = mountWith({ networks: null, uploads: true });
    expect(hostsAny().attributes('disabled')).toBeDefined();
  });

  it('turning "any network" off keeps the hosts that were typed', async () => {
    const { checks, hosts, emitted } = mountWith({ networks: null, uploads: true });
    await checks()[0].setValue(false);
    expect(emitted().at(-1)).toStrictEqual({ networks: [], uploads: true });
    await hosts().setValue(' IRC.Lurker.Chat , irc.libera.chat,');
    expect(emitted().at(-1)).toStrictEqual({
      networks: ['IRC.Lurker.Chat', 'irc.libera.chat'],
      uploads: true,
    });
  });

  it('emits the upload switch without touching the list', async () => {
    const { checks, emitted } = mountWith({ networks: ['irc.lurker.chat'], uploads: true });
    await checks()[1].setValue(false);
    expect(emitted().at(-1)).toStrictEqual({ networks: ['irc.lurker.chat'], uploads: false });
  });
});
