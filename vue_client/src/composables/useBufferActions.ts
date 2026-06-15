// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ContextMenuItem } from './useContextMenu.js';
import { usePinsStore } from '../stores/pins.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useFriendsStore } from '../stores/friends.js';
import { useWhoisStore } from '../stores/whois.js';
import { useContextMenu } from './useContextMenu.js';
import { socketSend } from './useSocket.js';

export interface BufferLike {
  networkId: number;
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
  const channelNotify = useChannelNotifyStore();
  const nickNotes = useNickNotesStore();
  const friends = useFriendsStore();
  const whois = useWhoisStore();
  const menu = useContextMenu();

  function buildItems(buf: BufferLike | null | undefined): ContextMenuItem[] {
    if (!buf || buf.target.startsWith(':server:')) return [];
    const isChannel = buf.target.startsWith('#');
    const kind = isChannel ? 'Channel' : 'DM';
    const pinned = pins.isPinned(buf.networkId, buf.target);
    const items: ContextMenuItem[] = [
      pinned
        ? {
            label: `Unpin ${kind}`,
            icon: 'fa-solid fa-thumbtack-slash',
            onClick: () => pins.unpin(buf.networkId, buf.target),
          }
        : {
            label: `Pin ${kind}`,
            icon: 'fa-solid fa-thumbtack',
            onClick: () => pins.pin(buf.networkId, buf.target),
          },
    ];
    if (isChannel) {
      const isAlwaysNotify = channelNotify.notifyAlways(buf.networkId, buf.target);
      items.push(
        // Icon reflects current state (solid = always-notifying, regular = not)
        // to match the topic-bar toggle; the label states the action.
        isAlwaysNotify
          ? {
              label: 'Stop Always Notifying',
              icon: 'fa-solid fa-bell',
              onClick: () => channelNotify.setNotifyAlways(buf.networkId, buf.target, false),
            }
          : {
              label: 'Always Notify',
              icon: 'fa-regular fa-bell',
              onClick: () => channelNotify.setNotifyAlways(buf.networkId, buf.target, true),
            },
      );
      // Mute hides the unread count + row color for ordinary traffic, leaving
      // highlights (and notifications) intact — for busy rooms you want to stay
      // in but not have nagging at you. Icon mirrors the always-notify pattern:
      // solid bell-slash = muted, regular bell-slash = not.
      const isMuted = channelNotify.muted(buf.networkId, buf.target);
      items.push(
        isMuted
          ? {
              label: 'Unmute Channel',
              icon: 'fa-solid fa-bell-slash',
              onClick: () => channelNotify.setMuted(buf.networkId, buf.target, false),
            }
          : {
              label: 'Mute Channel',
              icon: 'fa-regular fa-bell-slash',
              onClick: () => channelNotify.setMuted(buf.networkId, buf.target, true),
            },
      );
    } else {
      // DM target is the peer's nick — open the profile/note actions directly.
      // Channels can't carry a per-nick action from this menu (which nick?),
      // so these are DM-only; in-channel equivalents flow through the member
      // list menu.
      const hasNote = nickNotes.hasNote(buf.networkId, buf.target);
      const isFriend = !!friends.contactForTarget(buf.networkId, buf.target);
      items.push({
        label: 'View Profile…',
        icon: 'fa-solid fa-id-card',
        onClick: () => whois.openViewer(buf.networkId, buf.target),
      });
      items.push({
        label: hasNote ? 'Edit Note…' : 'Add Note…',
        icon: 'fa-solid fa-note-sticky',
        onClick: () => nickNotes.openEditor(buf.networkId, buf.target),
      });
      items.push({
        label: isFriend ? 'Edit Friend…' : 'Add Friend…',
        icon: 'fa-solid fa-user-group',
        onClick: () => friends.openEditorForNick(buf.networkId, buf.target),
      });
    }
    // Close drops the buffer entirely — for a channel that also PARTs it, for
    // a DM it just stops tracking the peer. Both are reversible (rejoin /
    // reopen), so no confirmation; the divider sets it apart from the
    // non-destructive pin/notify/note actions above.
    items.push(
      { divider: true },
      {
        label: `Close ${kind}`,
        icon: 'fa-solid fa-xmark',
        onClick: () =>
          socketSend({ type: 'close-buffer', networkId: buf.networkId, target: buf.target }),
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
