// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({ socketSend: vi.fn<() => boolean>(() => true) }));

import { useE2eChannelsStore } from './e2eChannels.js';
import { useBuffersStore } from './buffers.js';

beforeEach(() => setActivePinia(createPinia()));

describe('e2eChannels store (#422)', () => {
  it('takes each network’s list from the snapshot', () => {
    const s = useE2eChannelsStore();
    s.applySnapshot([
      { networkId: 1, e2eChannels: ['#secret'] },
      { networkId: 2, e2eChannels: [] },
    ]);
    expect(s.isEnabled(1, '#secret')).toBe(true);
    expect(s.isEnabled(1, '#open')).toBe(false);
    expect(s.isEnabled(2, '#secret')).toBe(false);
    expect(s.isEnabled(null, '#secret')).toBe(false);
  });

  it('a server without the field marks nothing', () => {
    const s = useE2eChannelsStore();
    s.applySnapshot([{ networkId: 1 }]);
    expect(s.isEnabled(1, '#secret')).toBe(false);
  });

  it('a change replaces one network’s list whole', () => {
    const s = useE2eChannelsStore();
    s.applySnapshot([
      { networkId: 1, e2eChannels: ['#a', '#b'] },
      { networkId: 2, e2eChannels: ['#c'] },
    ]);
    s.applyChange(1, ['#b']);
    expect(s.isEnabled(1, '#a')).toBe(false);
    expect(s.isEnabled(1, '#b')).toBe(true);
    expect(s.isEnabled(2, '#c')).toBe(true);
  });

  it('matches a buffer spelled in another case', () => {
    const buffers = useBuffersStore();
    buffers.ensure(1, '#Secret');
    const s = useE2eChannelsStore();
    s.applySnapshot([{ networkId: 1, e2eChannels: ['#secret'] }]);
    expect(s.isEnabled(1, '#Secret')).toBe(true);
  });
});
