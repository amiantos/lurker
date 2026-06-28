// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { usePinsStore } from '../stores/pins.js';
import { useFriendsStore } from '../stores/friends.js';
import { useNavHistoryStore } from '../stores/navHistory.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { socketSend } from './useSocket.js';
import { flattenBufferOrder, flattenUnreadOrder } from '../utils/bufferOrder.js';
import { FRIENDS_KEY } from '../lib/virtualBuffers.js';

export interface KeyboardShortcutsOptions {
  onOpenSwitcher?: () => void;
  onOpenHelp?: () => void;
  onOpenSearch?: () => void;
  onTypeAhead?: () => void;
  onScrollMessages?: (direction: number) => void;
}

function markAllRead(): void {
  socketSend({ type: 'mark-all-read' });
}

function isCmd(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}

// Entries keyboard nav can land on: real channels and DMs. The per-network
// server consoles (`:server:<id>`) and the virtual FRIENDS feed header are
// walked past, not landed on — you reach those by clicking.
function isNavTarget(entry: { key: string; target: string }): boolean {
  return !entry.target.startsWith(':server:') && entry.key !== FRIENDS_KEY;
}

// IRCCloud-style global shortcuts. Wired at the document level so they fire
// even when focus is in the message input — preventDefault stops them from
// also producing input-side effects (cursor by paragraph on Mac, etc.).
//
// Pass callbacks for the UI-driven shortcuts; the navigation/mark-read paths
// are self-contained. onTypeAhead fires when the user starts typing a
// printable character while focus is somewhere non-text — the consumer
// decides whether to redirect focus into the message input.
export function useKeyboardShortcuts({
  onOpenSwitcher,
  onOpenHelp,
  onOpenSearch,
  onTypeAhead,
  onScrollMessages,
}: KeyboardShortcutsOptions = {}): void {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const pins = usePinsStore();
  const friends = useFriendsStore();
  const navHistory = useNavHistoryStore();
  const recentBuffers = useRecentBuffersStore();

  // Feed the back/forward history (#309) and the quick switcher's MRU recency
  // list (#393) from one seam. networks.activeKey is the single place every
  // navigation path converges (sidebar click, quick switcher, slash commands,
  // deep links, the Friends pane), so recording there captures them all.
  // `flush: 'sync'` keeps navHistory's re-entrancy guard exact — the echo from
  // its own back()/forward() fires the instant activeKey mutates, before the
  // guard clears (recentBuffers has no such guard: a back/forward hop is a
  // genuine recent visit and should move to the front). Seed the current buffer
  // so the first Cmd+[ has somewhere to return from and the switcher opens with
  // recency already meaningful.
  watch(
    () => networks.activeKey,
    (key) => {
      if (key != null) {
        navHistory.record(key);
        recentBuffers.record(key);
      }
    },
    { flush: 'sync' },
  );
  if (networks.activeKey != null) {
    navHistory.record(networks.activeKey);
    recentBuffers.record(networks.activeKey);
  }

  // The FRIENDS group as the sidebar shows it: a feed header (only when there
  // are contacts) + each friend's primary DM, with those DMs excluded from
  // their real network so nav doesn't visit them twice.
  function friendsOrder() {
    return {
      dms: friends.primaryDmEntries,
      excludeKeys: friends.primaryDmKeys,
      feedKey: friends.contacts.length ? FRIENDS_KEY : undefined,
    };
  }

  function order() {
    return flattenBufferOrder({
      networks: networks.networks,
      buffers,
      pins,
      friends: friendsOrder(),
    });
  }

  function unreadOrder() {
    return flattenUnreadOrder({
      networks: networks.networks,
      buffers,
      pins,
      friends: friendsOrder(),
    });
  }

  // Activate the right way for the entry: the virtual FRIENDS feed goes through
  // the friends store (select + lazy-load); everything else is a real buffer.
  function activateEntry(entry: { networkId: string | number; target: string; key: string }): void {
    if (entry.key === FRIENDS_KEY) friends.open();
    else buffers.activate(entry.networkId, entry.target);
  }

  function step(delta: number, scope: 'all' | 'unread'): void {
    // Both Alt+Arrow (all buffers) and Shift+Alt+Arrow (unread only) walk the
    // full sidebar order across every network — neither is scoped to the
    // current network. We index against the *full* list (server consoles and
    // FRIENDS feed header included) so stepping off one of those skip-only
    // entries flows within its own section in sidebar order rather than jumping
    // to the top of the list; isNavTarget then walks past them to a real buffer.
    const list = scope === 'unread' ? unreadOrder() : order();
    if (!list.some(isNavTarget)) return;
    const activeKey = networks.activeKey;
    let idx = list.findIndex((e) => e.key === activeKey);
    if (idx === -1) {
      // Active buffer isn't in the list (e.g. unread nav when the current
      // buffer has no unread). Start just outside it so the first step lands on
      // the first/last entry, matching the requested direction.
      idx = delta > 0 ? -1 : list.length;
    }
    // Advance to the next landable buffer in the requested direction, skipping
    // server consoles and the FRIENDS feed header and wrapping around.
    for (let i = 0; i < list.length; i++) {
      idx = (idx + delta + list.length) % list.length;
      if (isNavTarget(list[idx])) {
        activateEntry(list[idx]);
        return;
      }
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    // Cmd/Ctrl + K — quick switcher
    if (isCmd(e) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      onOpenSwitcher?.();
      return;
    }
    // Cmd/Ctrl + F — message search
    if (isCmd(e) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      onOpenSearch?.();
      return;
    }
    // Cmd/Ctrl + / — help (browser doesn't shift to '?' for this combo on
    // most layouts, but accept '?' too in case a layout maps it that way)
    if (isCmd(e) && !e.altKey && (e.key === '/' || e.key === '?')) {
      e.preventDefault();
      onOpenHelp?.();
      return;
    }
    // PageUp / PageDown — scroll the message list a viewport at a time, even
    // when focus is in the message input (textareas otherwise eat the keys to
    // move the caret to the top/bottom of the field, which is identical to
    // Home/End for a single-line input and useless to the user). Skip when a
    // modal text field has focus so PgUp/PgDn in QuickSwitcher, Search, etc.
    // still does the normal caret thing.
    if ((e.key === 'PageUp' || e.key === 'PageDown') && !isCmd(e) && !e.altKey && !e.shiftKey) {
      if ((e.target as Element)?.closest?.('.modal')) return;
      e.preventDefault();
      onScrollMessages?.(e.key === 'PageUp' ? -1 : 1);
      return;
    }
    // Shift + Esc — mark all channels read
    if (e.key === 'Escape' && e.shiftKey && !isCmd(e) && !e.altKey) {
      e.preventDefault();
      markAllRead();
      return;
    }
    // Alt + arrows — channel navigation. Cmd/Ctrl must NOT be held so we
    // don't collide with browser shortcuts (Cmd+Alt+Arrow tab switching, etc.)
    if (e.altKey && !isCmd(e) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const scope = e.shiftKey ? 'unread' : 'all';
      // MessageInput's keydown handler also listens for ArrowUp/ArrowDown
      // (input history) but explicitly ignores them when Alt is held, so
      // these buffer-nav combos don't double-trigger.
      e.preventDefault();
      step(delta, scope);
      return;
    }
    // Cmd/Ctrl + [ / ] — back/forward through recently-visited buffers (#309).
    // Slack's history shortcut. Chosen over Cmd/Alt+Arrow because both of those
    // collide with text-cursor movement (line ends / word jumps) when focus is
    // in the message input. preventDefault also suppresses the browser's own
    // Cmd+[ / Cmd+] history navigation, which would otherwise leave the app.
    if (isCmd(e) && !e.altKey && !e.shiftKey && (e.key === '[' || e.key === ']')) {
      e.preventDefault();
      if (e.key === '[') navHistory.back();
      else navHistory.forward();
      return;
    }
    // Type-ahead: a bare printable character pressed while focus is on some
    // non-text element (a button, the body, the buffer list…) should land in
    // the message input. We only detect-and-delegate here — no preventDefault,
    // so once the consumer moves focus the character still types — and we skip
    // when focus is already in a text field (the input itself, the
    // switcher/search boxes, NickPicker filtering, etc.).
    if (!isCmd(e) && !e.altKey && e.key.length === 1) {
      if ((e.target as Element)?.closest?.('input, textarea, [contenteditable=true]')) return;
      onTypeAhead?.();
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
  });
}
