// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ContextMenuItem } from './useContextMenu.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { usePinsStore } from '../stores/pins.js';
import { useFavoritesStore } from '../stores/favorites.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useWhoisStore } from '../stores/whois.js';
import { useContextMenu } from './useContextMenu.js';
import { useNotifyLadder } from './useNotifyLadder.js';
import { useChannelModal } from './useChannelModal.js';
import { socketSend } from './useSocket.js';
import { isChannelTarget, isDccChatTarget, dccChatPeer } from '../../../shared/channels.js';

export interface BufferLike {
  // The server's stable buffer id, when the caller's store entry has learned
  // it (stores/buffers.ts Buffer.id) — attached to buffer-addressed verbs.
  id?: number;
  // null for the app-scoped system buffer (issue #355); buildItems bails on it
  // since every menu action is network-scoped.
  networkId: number | null;
  target: string;
}

export interface BufferActionsAPI {
  buildItems(buf: BufferLike | null | undefined): ContextMenuItem[];
  openMenuFor(buf: BufferLike | null | undefined, x: number, y: number): void;
  openMenuFromButton(buf: BufferLike | null | undefined, buttonEl: Element | null): void;
}

// Shared menu items for a buffer (channel/DM). Exposed as a composable so the
// sidebar right-click handler and the topic-bar cog button both surface the
// same actions. Server buffers have their own dedicated affordances (edit
// network, browse channels) and aren't handled here.
export function useBufferActions(): BufferActionsAPI {
  const buffers = useBuffersStore();
  const networks = useNetworksStore();
  const pins = usePinsStore();
  const favorites = useFavoritesStore();
  const nickNotes = useNickNotesStore();
  const whois = useWhoisStore();
  const menu = useContextMenu();
  const notify = useNotifyLadder();
  const channelModal = useChannelModal();

  function buildItems(buf: BufferLike | null | undefined): ContextMenuItem[] {
    // Capture networkId as a const after the null guard so the narrowing to
    // `number` survives inside the onClick closures below (a captured parameter
    // would widen back to number|null). Every menu action is network-scoped, so
    // the app-scoped system buffer (networkId null) yields no menu.
    const networkId = buf?.networkId;
    if (!buf || networkId == null || buf.target.startsWith(':server:')) return [];
    // Full channel-prefix test, matching the server's kindForTarget and the
    // favorites sections getter: '&'/'+'/'!' targets are channels, so they get
    // channel labels, the channel notify ladder, and channel icons — and are
    // never offered the DM-only profile/note items (whois on '&local' is
    // nonsense the old '#'-only test allowed).
    const isChannel = isChannelTarget(buf.target);
    // A `=nick` DCC chat is neither. It has a real peer behind it, so the
    // profile/note actions still make sense — but they must act on the PEER,
    // not on the buffer name: `whois.openViewer` puts its argument straight
    // into `WHOIS <nick>` on the wire (verbs/whois.ts:41), so passing `=bob`
    // there would leak a non-nick upstream. It is also not favoritable, for
    // the reason the server gives in wsHub's favorite-buffer case.
    const isDccChat = isDccChatTarget(buf.target);
    const peerNick = isDccChat ? dccChatPeer(buf.target) : buf.target;
    const kind = isChannel ? 'Channel' : isDccChat ? 'DCC Chat' : 'DM';
    const pinned = pins.isPinned(networkId, buf.target);
    // One flag, two labels: a favorited channel surfaces in the FAVORITES
    // section, a favorited DM under FRIENDS (the Friends/Contacts successor).
    const favorited = !isDccChat && favorites.isFavorite(networkId, buf.target);
    const favoriteSection = isChannel ? 'Favorites' : 'Friends';
    const items: ContextMenuItem[] = [];
    // A parted channel (a /part, a kick, or a rejoin the server refused — #873)
    // stays in the sidebar with its history, and getting back in is the usual
    // reason to open its menu, so Join leads. Same gate as the network menu's
    // Join Channel…: a JOIN needs a live connection.
    if (isChannel && buffers.findByTarget(networkId, buf.target)?.joined === false) {
      items.push(
        {
          label: 'Join Channel',
          icon: 'fa-solid fa-right-to-bracket',
          disabled: networks.states[networkId]?.state !== 'connected',
          onClick: () => buffers.joinOrToast(networkId, buf.target),
        },
        { divider: true },
      );
    }
    // A favorited buffer can't be pinned (one placement per buffer:
    // favorite⇒unpin server-side), so the pin item on a favorited buffer is
    // noise — hidden. The favorite item on a PINNED buffer stays: it's the
    // sanctioned way to promote a pin into the sections (the server drops the
    // pin as part of the grant).
    if (!favorited) {
      items.push(
        pinned
          ? {
              label: `Unpin ${kind}`,
              icon: 'fa-solid fa-thumbtack-slash',
              onClick: () => pins.unpin(networkId, buf.target),
            }
          : {
              label: `Pin ${kind}`,
              icon: 'fa-solid fa-thumbtack',
              onClick: () => pins.pin(networkId, buf.target),
            },
      );
    }
    if (!isDccChat) {
      items.push(
        favorited
          ? {
              label: `Remove from ${favoriteSection}`,
              icon: isChannel ? 'fa-regular fa-star' : 'fa-solid fa-user-minus',
              onClick: () => favorites.unfavorite(networkId, buf.target),
            }
          : {
              label: `Add to ${favoriteSection}`,
              icon: isChannel ? 'fa-solid fa-star' : 'fa-solid fa-user-group',
              onClick: () => favorites.favorite(networkId, buf.target),
            },
      );
    }
    // Notification "quietness" ladder (issue #359): channels get the full 4-rung
    // ladder (All / Highlights / Nothing / Muted), DMs the 3-rung one (no
    // "Highlights only" — every DM is already the signal).
    items.push(
      { divider: true },
      ...(isChannel
        ? notify.channelItems(networkId, buf.target)
        : notify.dmItems(networkId, buf.target)),
    );
    if (isChannel) {
      // The channel's own topic, modes and lists (#727) — for this channel, not
      // whichever one is on screen.
      items.push(
        { divider: true },
        {
          label: 'Channel Settings…',
          icon: 'fa-solid fa-sliders',
          onClick: () => channelModal.open(networkId, buf.target),
        },
      );
    } else {
      // DM target is the peer's nick — open the profile/note actions directly.
      // Channels can't carry a per-nick action from this menu (which nick?),
      // so these are DM-only; in-channel equivalents flow through the member
      // list menu.
      const hasNote = nickNotes.hasNote(networkId, peerNick);
      items.push(
        { divider: true },
        {
          label: 'View Profile…',
          icon: 'fa-solid fa-id-card',
          onClick: () => whois.openViewer(networkId, peerNick),
        },
        {
          label: hasNote ? 'Edit Note…' : 'Add Note…',
          icon: 'fa-solid fa-note-sticky',
          onClick: () => nickNotes.openEditor(networkId, peerNick),
        },
      );
    }
    // Close drops the buffer entirely — for a channel that also PARTs it, for
    // a DM it just stops tracking the peer. Both are reversible (rejoin /
    // reopen), so no confirmation; the divider sets it apart from the
    // non-destructive actions above.
    items.push(
      { divider: true },
      {
        label: `Close ${kind}`,
        icon: 'fa-solid fa-xmark',
        onClick: () =>
          socketSend({ type: 'close-buffer', networkId, target: buf.target, bufferId: buf.id }),
      },
    );
    return items;
  }

  function openMenuFor(buf: BufferLike | null | undefined, x: number, y: number): void {
    const items = buildItems(buf);
    if (items.length === 0) return;
    menu.open(items, x, y);
  }

  // Anchor the menu to the bottom-left of a triggering button so it drops down
  // from the cog rather than appearing at the cursor — keeps the menu visually
  // tethered to the affordance that opened it. The buttonEl is also handed to
  // useContextMenu so re-clicking the same trigger toggles the menu closed.
  function openMenuFromButton(buf: BufferLike | null | undefined, buttonEl: Element | null): void {
    if (!buttonEl) return;
    const items = buildItems(buf);
    if (items.length === 0) return;
    const rect = buttonEl.getBoundingClientRect();
    menu.open(items, rect.left, rect.bottom + 2, buttonEl);
  }

  return { buildItems, openMenuFor, openMenuFromButton };
}
