// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { ContextMenuItem } from './useContextMenu.js';
import { useBookmarksStore } from '../stores/bookmarks.js';
import { useContextMenu } from './useContextMenu.js';

export interface MessageLike {
  id?: number | null;
  nick?: string;
  text?: string;
  self?: boolean;
  userhost?: string;
  networkId?: number;
  network_id?: number;
}

export interface MessageContext {
  networkId: number;
  onReply(message: MessageLike): void;
  onIgnore(message: MessageLike): void;
}

export type MessageActionKey = 'reply' | 'copy' | 'save' | 'ignore';

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
  const menu = useContextMenu();

  function buildActions(message: MessageLike | null | undefined): MessageAction[] {
    if (!message) return [];
    const actions: MessageAction[] = [];

    // Reply and Ignore both address another user: pointless on your own line,
    // and the server uses the hostmask for delivery, not ignore filtering.
    const addressable = !message.self && !!message.nick;

    if (addressable) {
      actions.push({ key: 'reply', label: `Reply to ${message.nick}`, icon: 'fa-solid fa-reply' });
    }

    if (message.text) {
      actions.push({ key: 'copy', label: 'Copy text', icon: 'fa-regular fa-copy' });
    }

    // Bookmarks are only meaningful for messages with a stable server id.
    if (message.id != null) {
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
      case 'copy':
        if (navigator.clipboard) {
          navigator.clipboard.writeText(String(message.text || '')).catch(() => {});
        }
        break;
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
