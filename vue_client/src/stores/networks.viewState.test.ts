// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A network's sidebar view state (#1432, #1034): folded, and whether its
// muted channels are hidden. Set from a click, echoed by the server, and
// carried on the snapshot.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({ socketSend: vi.fn<(payload: unknown) => boolean>(() => true) }));
vi.mock('../composables/useSocket.js', () => ({ socketSend: h.socketSend }));

import { useNetworksStore } from './networks.js';

describe('network view state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.socketSend.mockReset().mockReturnValue(true);
    useNetworksStore().networks = [{ id: 1, name: 'libera', collapsed: false }] as never;
  });

  const net = () => useNetworksStore().networks[0];

  it('sends the change and shows it at once', () => {
    const networks = useNetworksStore();
    networks.setCollapsed(1, true);
    networks.setHideMuted(1, true);

    expect(h.socketSend.mock.calls.map((c) => c[0])).toEqual([
      { type: 'set-network-collapsed', networkId: 1, collapsed: true },
      { type: 'set-network-hide-muted', networkId: 1, hideMuted: true },
    ]);
    expect([net().collapsed, net().hide_muted]).toEqual([true, true]);
  });

  it('changes nothing while the socket is down', () => {
    h.socketSend.mockReturnValue(false);
    const networks = useNetworksStore();
    networks.setCollapsed(1, true);
    networks.setHideMuted(1, true);

    expect([net().collapsed, net().hide_muted]).toEqual([false, undefined]);
  });

  it('takes both from a snapshot, and leaves them alone when it carries neither', () => {
    const networks = useNetworksStore();
    networks.applySnapshot([
      { networkId: 1, channels: [], collapsed: true, hideMuted: true },
    ] as never);
    expect([net().collapsed, net().hide_muted]).toEqual([true, true]);

    networks.applySnapshot([{ networkId: 1, channels: [] }] as never);
    expect([net().collapsed, net().hide_muted]).toEqual([true, true]);
  });
});
