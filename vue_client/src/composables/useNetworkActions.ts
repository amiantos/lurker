// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ContextMenuItem } from './useContextMenu.js';
import { useContextMenu } from './useContextMenu.js';
import { useChannelListModal } from './useChannelListModal.js';
import { useNetworkEditor } from './useNetworkEditor.js';
import { useNotifyLadder } from './useNotifyLadder.js';
import { useNetworksStore, type Network } from '../stores/networks.js';

// Buffer-list action logic for network rows. Analogous to useBufferActions for
// channel/DM rows. Opens the channel list modal or a two-item overflow menu
// (Edit Network + Disconnect/Reconnect) anchored to a button or cursor position.
export function useNetworkActions() {
  const menu = useContextMenu();
  const channelListModal = useChannelListModal();
  const networkEditor = useNetworkEditor();
  const notify = useNotifyLadder();
  const networks = useNetworksStore();

  function toggleConnection(networkId: number): void {
    const state = networks.states[networkId]?.state;
    const p =
      state === 'connected' ? networks.disconnect(networkId) : networks.reconnect(networkId);
    p.catch((err) => console.error('[useNetworkActions] toggle connection failed', err));
  }

  function buildItems(net: Network): ContextMenuItem[] {
    const isConnected = networks.states[net.id]?.state === 'connected';
    return [
      {
        label: 'Edit Network',
        icon: 'fa-solid fa-gear',
        onClick: () => networkEditor.open(net),
      },
      {
        label: isConnected ? 'Disconnect' : 'Reconnect',
        icon: isConnected ? 'fa-solid fa-plug-circle-xmark' : 'fa-solid fa-plug',
        onClick: () => toggleConnection(net.id),
      },
      // Network-wide notification ladder (issue #359): Highlights only (default)
      // / Nothing / Muted — a -network-scoped NONOTIFY(+NOUNREAD) rule covering
      // every buffer on the network.
      { divider: true },
      ...notify.networkItems(net.id),
    ];
  }

  function openMenuFromButton(net: Network, buttonEl: Element | null): void {
    if (!buttonEl) return;
    const rect = buttonEl.getBoundingClientRect();
    menu.open(buildItems(net), rect.left, rect.bottom + 2, buttonEl);
  }

  function onNetworkContextMenu(net: Network, x: number, y: number): void {
    menu.open(buildItems(net), x, y);
  }

  function openChannelList(net: Network): void {
    channelListModal.open(net.id);
  }

  return { openMenuFromButton, onNetworkContextMenu, openChannelList };
}
