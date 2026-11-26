// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBufferSearchScope } from './useBufferSearchScope.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';

describe('useBufferSearchScope', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useNetworksStore().networks = [{ id: 5, name: 'libera' }] as never;
  });

  function scopeIn(key: string): string | null {
    useNetworksStore().activeKey = key;
    const s = useBufferSearchScope();
    s.openSearch(true);
    return s.searchScope.value;
  }

  it('scopes a channel by its name and network', () => {
    expect(scopeIn('5::#dev')).toBe('in:#dev on:libera');
  });

  it('scopes a server buffer by its own target (#1437)', () => {
    expect(scopeIn('5:::server:5')).toBe('in::server:5 on:libera');
  });

  it('leaves the system buffer unscoped', () => {
    expect(scopeIn(SYSTEM_KEY)).toBeNull();
  });
});
