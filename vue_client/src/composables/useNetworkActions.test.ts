// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The Disconnect/Reconnect item the network menu and the mobile server kebab
// share (#1136): it acts on the state it was labelled from.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<(payload: unknown) => boolean>(() => true),
}));

import { useNetworkActions } from './useNetworkActions.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

function networkState(state: string): void {
  useNetworksStore().states[1] = { networkId: 1, channels: [], state } as never;
}

describe('useNetworkActions connectionItem', () => {
  let disconnect: ReturnType<typeof vi.fn>;
  let reconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    const networks = useNetworksStore();
    disconnect = vi.spyOn(networks, 'disconnect').mockResolvedValue(undefined as never);
    reconnect = vi.spyOn(networks, 'reconnect').mockResolvedValue(undefined as never);
  });

  it('says Disconnect while connected or reconnecting, Reconnect otherwise', () => {
    const { connectionItem } = useNetworkActions();
    networkState('connected');
    expect(connectionItem(1).label).toBe('Disconnect');
    networkState('reconnecting');
    expect(connectionItem(1).label).toBe('Disconnect');
    networkState('disconnected');
    expect(connectionItem(1).label).toBe('Reconnect');
  });

  it('disconnects when it said Disconnect, though the state moved since', () => {
    networkState('reconnecting');
    const item = useNetworkActions().connectionItem(1);
    expect(item.label).toBe('Disconnect');
    // The retry gate refuses while the menu is open, and the state settles.
    networkState('disconnected');
    item.onClick?.();
    expect(disconnect).toHaveBeenCalledWith(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('reconnects when it said Reconnect, though the state moved since', () => {
    networkState('disconnected');
    const item = useNetworkActions().connectionItem(1);
    expect(item.label).toBe('Reconnect');
    networkState('connected');
    item.onClick?.();
    expect(reconnect).toHaveBeenCalledWith(1);
    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe('useNetworkActions refused toggle', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('says why a Reconnect was refused, in the network’s server buffer', async () => {
    const networks = useNetworksStore();
    vi.spyOn(networks, 'reconnect').mockRejectedValue(
      new Error('this server only allows the networks its admin has listed'),
    );
    const said = vi.spyOn(useBuffersStore(), 'pushMessage').mockImplementation(() => true);
    networkState('disconnected');
    useNetworkActions().connectionItem(1).onClick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(said).toHaveBeenCalledWith(
      expect.objectContaining({
        networkId: 1,
        target: ':server:1',
        text: 'could not connect: this server only allows the networks its admin has listed',
      }),
    );
  });

  it('says a refused Disconnect as one', async () => {
    const networks = useNetworksStore();
    vi.spyOn(networks, 'disconnect').mockRejectedValue(new Error('nope'));
    const said = vi.spyOn(useBuffersStore(), 'pushMessage').mockImplementation(() => true);
    networkState('connected');
    useNetworkActions().connectionItem(1).onClick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(said).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'could not disconnect: nope' }),
    );
  });
});
