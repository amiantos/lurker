// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';

let nextId = 1;

// Action callbacks live module-local, keyed by toast id — never in Pinia state.
// The store keeps only the serializable `{ label }` so $reset / devtools /
// persistence never have to deal with a function (same rationale as the
// drafts store's module-local timers). Registered in push(), cleared in
// dismiss()/clear() so the map can't outlive its toast.
const actionHandlers = new Map<number, () => void>();

export type ToastKind = 'highlight' | 'dm' | 'always_notify' | 'notify' | 'info' | 'warn' | 'error';

// An explicit call-to-action button rendered inside the toast (e.g. the "Join"
// on a channel-invite toast). Distinct from the whole-toast click, which only
// activates an existing buffer — an action can run any handler, so it's the
// primitive for toasts that offer to *do* something rather than navigate. The
// handler is split off into the module-local map above; only `label` is stored.
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  title: string;
  body: string;
  networkId?: number;
  target?: string;
  messageId?: number;
  kind: ToastKind;
  // Serializable subset of ToastAction — the onClick is held in actionHandlers.
  action?: { label: string };
}

export interface ToastOptions {
  title: string;
  body: string;
  networkId?: number;
  target?: string;
  messageId?: number;
  kind?: ToastKind;
  ttlMs?: number;
  action?: ToastAction;
}

export const useToastsStore = defineStore('toasts', {
  state: () => ({
    items: [] as Toast[],
  }),
  actions: {
    push({
      title,
      body,
      networkId,
      target,
      messageId,
      kind = 'highlight',
      ttlMs = 5000,
      action,
    }: ToastOptions) {
      const id = nextId++;
      if (action) actionHandlers.set(id, action.onClick);
      this.items.push({
        id,
        title,
        body,
        networkId,
        target,
        messageId,
        kind,
        action: action ? { label: action.label } : undefined,
      });
      if (ttlMs > 0) {
        setTimeout(() => this.dismiss(id), ttlMs);
      }
      return id;
    },
    // Run a toast's action handler (looked up module-local, not from state).
    runAction(id: number) {
      actionHandlers.get(id)?.();
    },
    dismiss(id: number) {
      actionHandlers.delete(id);
      const idx = this.items.findIndex((t) => t.id === id);
      if (idx >= 0) this.items.splice(idx, 1);
    },
    clear() {
      actionHandlers.clear();
      this.items = [];
    },
  },
});
