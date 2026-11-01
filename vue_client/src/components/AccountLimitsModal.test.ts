// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// A hosted cell gets the service's pitch and a Subscribe link; self-hosted,
// a sentence that follows the restriction set and nothing to buy.

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AccountLimitsModal from './AccountLimitsModal.vue';
import { useAuthStore } from '../stores/auth.js';
import { useConfigStore } from '../stores/config.js';
import type { AccountRestrictions } from '../../../shared/accountRestrictions.js';

function setUp(restrictions: AccountRestrictions, edition: 'node' | 'standalone') {
  const auth = useAuthStore();
  auth.user = { id: 1, username: 'held', role: 'user' } as NonNullable<typeof auth.user>;
  auth.setRestrictions(restrictions);
  useConfigStore().edition = edition;
  return mount(AccountLimitsModal, { global: { stubs: { WordBackdrop: true } } });
}

beforeEach(() => setActivePinia(createPinia()));

describe('AccountLimitsModal', () => {
  it('is the subscribe pitch on a hosted cell', () => {
    const w = setUp({ networks: ['irc.lurker.chat'], uploads: false }, 'node');
    expect(w.find('h2').text()).toBe('Subscribe for all features');
    expect(w.find('.body').text()).toContain('Your free Lurker.Chat account');
    expect(w.find('a.subscribe').attributes('href')).toBe('/account');
  });
  it('says only what is held, and offers nothing to buy when self-hosted', () => {
    const w = setUp({ networks: null, uploads: false }, 'standalone');
    expect(w.find('h2').text()).toBe('account limits');
    expect(w.find('.body').text()).toBe("This account can't upload files.");
    expect(w.find('a.subscribe').exists()).toBe(false);
  });
});
