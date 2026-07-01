// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ContextMenuItem } from './useContextMenu.js';
import { usePinsStore } from '../stores/pins.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useFriendsStore } from '../stores/friends.js';
import { useWhoisStore } from '../stores/whois.js';
import { useContextMenu } from './useContextMenu.js';
import { useNotifyLadder } from './useNotifyLadder.js';
import { socketSend } from './useSocket.js';

export interface BufferLike {
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
  const pins = usePinsStore();
  const nickNotes = useNickNotesStore();
  const friends = useFriendsStore();
  const whois = useWhoisStore();
  const menu = useContextMenu();
  const notify = useNotifyLadder();

  function buildItems(buf: BufferLike | null | undefined): ContextMenuItem[] {
    // Capture networkId as a const after the null guard so the narrowing to
    // `number` survives inside the onClick closures below (a captured parameter
    // would widen back to number|null). Every menu action is network-scoped, so
    // the app-scoped system buffer (networkId null) yields no menu.
    const networkId = buf?.networkId;
    if (!buf || networkId == null || buf.target.startsWith(':server:')) return [];
    const isChannel = buf.target.startsWith('#');
    const kind = isChannel ? 'Channel' : 'DM';
    const pinned = pins.isPinned(networkId, buf.target);
    const items: ContextMenuItem[] = [
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
    ];
    // Notification "quietness" ladder (issue #359): channels get the full 4-rung
    // ladder (All / Highlights / Nothing / Muted), DMs the 3-rung one (no
    // "Highlights only" — every DM is already the signal).
    items.push(
      { divider: true },
      ...(isChannel
        ? notify.channelItems(networkId, buf.target)
        : notify.dmItems(networkId, buf.target)),
    );
    if (!isChannel) {
      // DM target is the peer's nick — open the profile/note actions directly.
      // Channels can't carry a per-nick action from this menu (which nick?),
      // so these are DM-only; in-channel equivalents flow through the member
      // list menu.
      const hasNote = nickNotes.hasNote(networkId, buf.target);
      const isFriend = !!friends.contactForTarget(networkId, buf.target);
      items.push(
        { divider: true },
        {
          label: 'View Profile…',
          icon: 'fa-solid fa-id-card',
          onClick: () => whois.openViewer(networkId, buf.target),
        },
        {
          label: hasNote ? 'Edit Note…' : 'Add Note…',
          icon: 'fa-solid fa-note-sticky',
          onClick: () => nickNotes.openEditor(networkId, buf.target),
        },
        {
          label: isFriend ? 'Edit Friend…' : 'Add Friend…',
          icon: 'fa-solid fa-user-group',
          onClick: () => friends.openEditorForNick(networkId, buf.target),
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
        onClick: () => socketSend({ type: 'close-buffer', networkId, target: buf.target }),
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
