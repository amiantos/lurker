// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// When the + should answer with the limits modal instead of the picker: only
// once a held account already has a connection to every host it may use.

import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAccountLimits, resetAccountLimits } from './useAccountLimits.js';
import { useAuthStore } from '../stores/auth.js';
import { useNetworksStore, type Network } from '../stores/networks.js';

function setUp(networks: string[] | null, hosts: string[]) {
  const auth = useAuthStore();
  auth.user = { id: 1, username: 'held', role: 'user' } as NonNullable<typeof auth.user>;
  if (networks) auth.setRestrictions({ networks, uploads: false });
  useNetworksStore().networks = hosts.map((host, i) => ({ id: i + 1, host }) as Network);
}

beforeEach(() => setActivePinia(createPinia()));

describe('useAccountLimits.isOpen', () => {
  it("closes with the session, so the next account never sees the last one's pitch", () => {
    setUp(['irc.lurker.chat'], []);
    const limits = useAccountLimits();
    limits.open();
    expect(limits.isOpen.value).toBe(true);
    resetAccountLimits();
    expect(useAccountLimits().isOpen.value).toBe(false);
  });
});

describe('useAccountLimits.addNetworkHeld', () => {
  it('holds the + once every allowed host has a row, whatever the case', () => {
    setUp(['irc.lurker.chat'], ['IRC.Lurker.Chat']);
    expect(useAccountLimits().addNetworkHeld.value).toBe(true);
  });
  it('lets the picker offer a listed host that has no row yet', () => {
    setUp(['irc.lurker.chat', 'irc.libera.chat'], ['irc.lurker.chat']);
    expect(useAccountLimits().addNetworkHeld.value).toBe(false);
  });
  it('never holds an account under no list', () => {
    setUp(null, ['irc.lurker.chat', 'irc.libera.chat']);
    expect(useAccountLimits().addNetworkHeld.value).toBe(false);
  });
  it('leaves an empty list to the picker, which says so', () => {
    setUp([], []);
    expect(useAccountLimits().addNetworkHeld.value).toBe(false);
  });
});
