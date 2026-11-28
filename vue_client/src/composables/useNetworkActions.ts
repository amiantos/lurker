// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { HashIcon, PlugIcon, PlusIcon, SettingsIcon, UnplugIcon, UserPenIcon } from '@lucide/vue';
import type { ContextMenuItem } from './useContextMenu.js';
import { checkboxItem, useContextMenu } from './useContextMenu.js';
import { useChannelListModal } from './useChannelListModal.js';
import { useJoinChannelModal } from './useJoinChannelModal.js';
import { useNetworkEditor } from './useNetworkEditor.js';
import { useNotifyLadder } from './useNotifyLadder.js';
import { useProfileEditor } from './useProfileEditor.js';
import { canDisconnect, useNetworksStore, type Network } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

// A Reconnect or Disconnect the server refused, said in the network's server
// buffer. The server's reason is the useful part: a host the admin's list no
// longer allows, an account limited to other networks. Without it the button
// does nothing at all.
export function connectionToggleFailed(
  networkId: number,
  wantedDisconnect: boolean,
  err: unknown,
): void {
  const reason = (err instanceof Error && err.message) || 'request failed';
  useBuffersStore().pushMessage({
    networkId,
    target: `:server:${networkId}`,
    type: 'motd',
    text: `could not ${wantedDisconnect ? 'disconnect' : 'connect'}: ${reason}`,
    time: new Date().toISOString(),
  });
}

// Buffer-list action logic for network rows. Analogous to useBufferActions for
// channel/DM rows. Builds the network context menu — Join Channel / Channel List,
// Edit Network / Disconnect·Reconnect, and the notification ladder — anchored to
// a button (the header kebab) or a cursor position (right-click / long-press).
export function useNetworkActions() {
  const menu = useContextMenu();
  const channelListModal = useChannelListModal();
  const joinChannelModal = useJoinChannelModal();
  const networkEditor = useNetworkEditor();
  const notify = useNotifyLadder();
  const profileEditor = useProfileEditor();
  const networks = useNetworksStore();

  // ⚠ Takes the decision rather than re-deriving it. connectionItem labels the item when the
  // menu OPENS (the network menu here, the mobile server kebab); re-reading the state at click
  // time lets the two disagree while the menu sits there, and it is reachable: open it during a
  // backoff (item reads "Disconnect"), the reconnect gate then refuses (paused account, host
  // dropped from the allowlist) and stopReconnecting settles the state to 'disconnected', so
  // the click on "Disconnect" would fire a RECONNECT (#1136).
  function toggleConnection(networkId: number, offerDisconnect: boolean): void {
    const p = offerDisconnect ? networks.disconnect(networkId) : networks.reconnect(networkId);
    p.catch((err) => connectionToggleFailed(networkId, offerDisconnect, err));
  }

  // Disconnect or Reconnect, decided once, now: the label and the action are the same reading
  // of the state however long the menu then stays open (#1136). Disconnect covers the
  // in-flight states too, since during a backoff it is what stops the loop (#785).
  function connectionItem(networkId: number): ContextMenuItem {
    const offerDisconnect = canDisconnect(networks.states[networkId]?.state);
    return {
      label: offerDisconnect ? 'Disconnect' : 'Reconnect',
      icon: offerDisconnect ? UnplugIcon : PlugIcon,
      onClick: () => toggleConnection(networkId, offerDisconnect),
    };
  }

  function buildItems(net: Network): ContextMenuItem[] {
    const state = networks.states[net.id]?.state;
    const isConnected = state === 'connected';
    // Join stays on isConnected, the question of whether there's a socket to send JOIN on;
    // Disconnect is a different one (connectionItem).
    return [
      // Channel actions first — the common reason to reach for a network's menu.
      // Join needs a live connection; the channel list is still browsable from
      // cache while disconnected, so only Join is gated.
      {
        label: 'Join Channel…',
        icon: PlusIcon,
        disabled: !isConnected,
        onClick: () => joinChannelModal.open(net.id),
      },
      {
        label: 'Channel List…',
        icon: HashIcon,
        onClick: () => channelListModal.open(net.id),
      },
      { divider: true },
      {
        label: 'Edit Network',
        icon: SettingsIcon,
        onClick: () => networkEditor.open(net),
      },
      // Your own metadata here (#1189): display name, avatar, …
      {
        label: 'Edit Profile…',
        icon: UserPenIcon,
        disabled: !profileEditor.canOpen(net.id),
        onClick: () => profileEditor.open(net.id),
      },
      connectionItem(net.id),
      // Network-wide notification ladder (issue #359): Highlights only (default)
      // / Nothing / Muted — a -network-scoped NONOTIFY(+NOUNREAD) rule covering
      // every buffer on the network.
      { divider: true },
      ...notify.networkItems(net.id),
      // Per network (#1034).
      { divider: true },
      checkboxItem('Hide Muted Channels', !!net.hideMuted, (next) =>
        networks.setHideMuted(net.id, next),
      ),
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

  return { openMenuFromButton, onNetworkContextMenu, connectionItem };
}
