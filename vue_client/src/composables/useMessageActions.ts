// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ContextMenuItem } from './useContextMenu.js';
import { useBookmarksStore } from '../stores/bookmarks.js';
import { useReactionsStore } from '../stores/reactions.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useContextMenu } from './useContextMenu.js';

export interface MessageLike {
  id?: number | null;
  nick?: string;
  text?: string;
  self?: boolean;
  userhost?: string;
  // Null on the app-scoped system buffer, which has no owning network — see the
  // bookmark gate in buildActions.
  networkId?: number | null;
  network_id?: number | null;
  // The buffer the line belongs to. Present on every real message row; the
  // fallback for resolving the buffer id "Copy link" addresses.
  target?: string;
  // buffers(id), as it rides on the server's message events — the direct
  // answer, when the row came from the server rather than being minted here.
  bufferId?: number;
  // The server's IRCv3 msgid — what a reaction replies to. Absent on networks
  // without message-tags and on lines sent before echo-message stamped them.
  msgid?: string;
  // An end-to-end encrypted line; reactions are cleartext tags, so none here.
  e2e?: boolean;
}

export interface MessageContext {
  networkId: number;
  onReply(message: MessageLike): void;
  onIgnore(message: MessageLike): void;
}

export type MessageActionKey = 'reply' | 'react' | 'copy' | 'link' | 'save' | 'ignore';

export interface MessageAction {
  key: MessageActionKey;
  // Tooltip + accessible label for the icon button.
  label: string;
  // Font Awesome classes for the button glyph.
  icon: string;
  // Toggles the "lit" treatment — currently only the bookmark when saved.
  active?: boolean;
}

export interface MessageActionsAPI {
  buildActions(message: MessageLike | null | undefined): MessageAction[];
  run(key: MessageActionKey, message: MessageLike, ctx: MessageContext): void;
  // The same actions rendered as ContextMenuItem[] for the right-click / tap
  // menu (#392). Derived from buildActions so the bar and the menu can't drift.
  buildItems(message: MessageLike | null | undefined, ctx: MessageContext): ContextMenuItem[];
  // Open the shared context menu at a viewport point for this message.
  openMenu(
    message: MessageLike | null | undefined,
    ctx: MessageContext,
    x: number,
    y: number,
    triggerEl?: Element | null,
  ): void;
}

// Single source of truth for the per-message actions rendered as the hover
// action bar in MessageList (issue #117 — replaced the kebab + context menu).
//
// buildActions() returns plain descriptors (no per-row handler closures) so
// the bar — re-evaluated for up to MAX_PER_BUFFER rows on every render — stays
// allocation-light; clicks are dispatched through run() with a context the
// caller builds once. The caller owns the component-local UI for the ignore
// confirmation (mirrors useMemberActions) and the reply hand-off to the
// composer, supplying both via that context.
//
// `message` shape: { id, nick, text, self, userhost, network_id|networkId, ... }
// `context` shape: { networkId, onReply(message), onIgnore(message) }
export function useMessageActions(): MessageActionsAPI {
  const bookmarks = useBookmarksStore();
  const reactions = useReactionsStore();
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const menu = useContextMenu();

  // Absolute permalink to one message, or null when the line can't have one.
  // The buffer route addresses by server id (#744), so this needs the message's
  // id AND its buffer's — and it deliberately refuses the two kinds of line a
  // link couldn't actually land on:
  //
  //   - app-scoped system lines (networkId null), which have no buffer route
  //     that a per-message jump accepts
  //   - `:server:` consoles, which useJumpToMessage rejects outright ("Cannot
  //     jump in server buffer") — a link there would open the buffer and then
  //     toast at the user instead of scrolling
  //
  // Prefers the id the row already carries — server message events ship
  // `bufferId` and the store keeps the event object whole, so the usual case
  // needs no lookup at all. That matters because buildActions runs for EVERY
  // rendered row (up to MAX_PER_BUFFER of them) on every re-render, and
  // findByTarget's exact-key fast path degrades to an O(buffers) folded scan
  // whenever the message's server-cased target differs from the buffer key —
  // the #327 case — which would make it O(rows x buffers) per render.
  // findByTarget stays as the fallback for rows minted locally.
  //
  // Split in two — linkBufferId answers "can this line link, and to which
  // buffer", messageLink formats the URL — so buildActions' per-row
  // eligibility test stays allocation-free: building the string just to test
  // truthiness was waste at that call frequency.
  function linkBufferId(message: MessageLike): number | null {
    const networkId = message.networkId ?? message.network_id;
    if (message.id == null || networkId == null) return null;
    if (!message.target || message.target.startsWith(':server:')) return null;
    const bufferId =
      typeof message.bufferId === 'number'
        ? message.bufferId
        : buffers.findByTarget(networkId, message.target)?.id;
    return bufferId ?? null;
  }

  function messageLink(message: MessageLike): string | null {
    const bufferId = linkBufferId(message);
    if (bufferId == null) return null;
    return `${window.location.origin}/buffer/${bufferId}?msg=${message.id}`;
  }

  function buildActions(message: MessageLike | null | undefined): MessageAction[] {
    if (!message) return [];
    const actions: MessageAction[] = [];

    // Reply and Ignore both address another user: pointless on your own line,
    // and the server uses the hostmask for delivery, not ignore filtering.
    const addressable = !message.self && !!message.nick;

    if (addressable) {
      actions.push({ key: 'reply', label: `Reply to ${message.nick}`, icon: 'fa-solid fa-reply' });
    }

    // A reaction replies to the line's msgid, so the line needs one, and the
    // network has to be up and able to carry it (canReact — see the server's
    // canSendReactions). The server re-checks all of it; this just keeps a
    // button off lines where it could only do nothing.
    const reactNetworkId = message.networkId ?? message.network_id;
    if (message.id != null && reactNetworkId != null && message.msgid && !message.e2e) {
      const state = networks.states[reactNetworkId];
      if (state?.state === 'connected' && state.canReact) {
        actions.push({ key: 'react', label: 'React', icon: 'fa-regular fa-face-smile' });
      }
    }

    if (message.text) {
      actions.push({ key: 'copy', label: 'Copy text', icon: 'fa-regular fa-copy' });
    }

    // Sits next to Copy text because it's the other "take this away with you"
    // action: a permalink to bookmark, or to open in a new window.
    if (linkBufferId(message) != null) {
      actions.push({ key: 'link', label: 'Copy link to message', icon: 'fa-solid fa-link' });
    }

    // Bookmarks need a stable server id AND an owning network.
    //
    // The network gate is not cosmetic. Bookmarking is ownership-checked by
    // joining the message to its network (db/bookmarks.ts), so a system-buffer
    // line — `networkId: null`, app-scoped — can never be saved: the insert
    // writes nothing and the server sends no echo back. Offering "Save message"
    // there was a button that did nothing, forever, with no feedback.
    //
    // It also closes a mislabel. System lines come from their own table with
    // their own id sequence (`systemLineToEvent`), so system line #42 and
    // message #42 coexist; asking `isSaved(42)` for the former would light up
    // "Remove bookmark" on a line nobody ever saved.
    const networkId = message.networkId ?? message.network_id;
    if (message.id != null && networkId != null) {
      const saved = bookmarks.isSaved(message.id);
      actions.push({
        key: 'save',
        label: saved ? 'Remove bookmark' : 'Save message',
        icon: saved ? 'fa-solid fa-bookmark' : 'fa-regular fa-bookmark',
        active: saved,
      });
    }

    if (addressable) {
      actions.push({ key: 'ignore', label: `Ignore ${message.nick}…`, icon: 'fa-solid fa-ban' });
    }

    return actions;
  }

  function run(key: MessageActionKey, message: MessageLike, ctx: MessageContext): void {
    switch (key) {
      case 'reply':
        ctx.onReply(message);
        break;
      case 'react':
        reactions.openPicker({
          id: message.id,
          networkId: message.networkId ?? message.network_id ?? null,
          nick: message.nick,
          text: message.text,
        });
        break;
      case 'copy':
        if (navigator.clipboard) {
          navigator.clipboard.writeText(String(message.text || '')).catch(() => {});
        }
        break;
      case 'link': {
        // Fire-and-forget with no tick, matching its neighbour above — the
        // action bar renders stateless descriptors, and useCopyFeedback calls
        // out the copy-message action as deliberately not that shape.
        const url = messageLink(message);
        if (url && navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
        break;
      }
      case 'save':
        bookmarks.toggle(message);
        break;
      case 'ignore':
        ctx.onIgnore(message);
        break;
    }
  }

  // Map the descriptor list to context-menu items. Each item dispatches back
  // through run() with the caller's context, so the menu shares the bar's exact
  // side effects (reply hand-off, clipboard, bookmark toggle, ignore modal).
  function buildItems(
    message: MessageLike | null | undefined,
    ctx: MessageContext,
  ): ContextMenuItem[] {
    if (!message) return [];
    return buildActions(message).map((a) => ({
      label: a.label,
      icon: a.icon,
      onClick: () => run(a.key, message, ctx),
    }));
  }

  function openMenu(
    message: MessageLike | null | undefined,
    ctx: MessageContext,
    x: number,
    y: number,
    triggerEl: Element | null = null,
  ): void {
    if (!message) return;
    const items = buildItems(message, ctx);
    if (items.length === 0) return;
    menu.open(items, x, y, triggerEl);
  }

  return { buildActions, run, buildItems, openMenu };
}
