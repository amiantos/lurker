// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { onBeforeUnmount, onMounted } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { usePinsStore } from '../stores/pins.js';
import { socketSend } from './useSocket.js';
import { flattenBufferOrder, flattenUnreadOrder } from '../utils/bufferOrder.js';

// IRCCloud-style global shortcuts. Wired at the document level so they fire
// even when focus is in the message input — preventDefault stops them from
// also producing input-side effects (cursor by paragraph on Mac, etc.).
//
// Pass callbacks for the UI-driven shortcuts; the navigation/mark-read paths
// are self-contained.
export function useKeyboardShortcuts({ onOpenSwitcher, onOpenHelp, onOpenSearch } = {}) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  const pins = usePinsStore();

  function order() {
    return flattenBufferOrder({
      networks: networks.networks,
      buffers,
      pins,
    });
  }

  function unreadOrder() {
    return flattenUnreadOrder({
      networks: networks.networks,
      buffers,
      pins,
    });
  }

  function activeNetworkId() {
    const a = networks.activeBuffer;
    return a?.networkId ?? null;
  }

  function step(delta, scope) {
    let list = order();
    if (scope === 'network') {
      const nid = activeNetworkId();
      if (nid != null) list = list.filter((e) => e.networkId === nid);
    } else if (scope === 'unread') {
      list = unreadOrder();
    }
    if (list.length === 0) return;
    const activeKey = networks.activeKey;
    let idx = list.findIndex((e) => `${e.networkId}::${e.target}` === activeKey);
    if (idx === -1) {
      // Active buffer isn't in the filtered list (e.g. unread navigation when
      // current buffer has no unread). Pick the first item in the requested
      // direction so wrap-around still feels predictable.
      idx = delta > 0 ? -1 : list.length;
    }
    const next = (idx + delta + list.length) % list.length;
    const target = list[next];
    if (target) buffers.activate(target.networkId, target.target);
  }

  function markAllRead() {
    socketSend({ type: 'mark-all-read' });
  }

  function isCmd(e) {
    return e.metaKey || e.ctrlKey;
  }

  function onKeydown(e) {
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
      const scope = e.shiftKey ? 'unread' : 'network';
      // MessageInput's keydown handler also listens for ArrowUp/ArrowDown
      // (input history) but explicitly ignores them when Alt is held, so
      // these buffer-nav combos don't double-trigger.
      e.preventDefault();
      step(delta, scope);
      return;
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
  });
}
