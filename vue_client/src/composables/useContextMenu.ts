// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { reactive } from 'vue';
import { SquareCheckIcon, SquareIcon, type LucideIcon } from '@lucide/vue';

// Single global context menu, controlled imperatively by any consumer.
// State is module-level so every useContextMenu() caller shares the same
// instance and there's exactly one popup on screen at a time. Mount one
// <ContextMenu /> at the app root (App.vue) — it reads from this state.
//
// Items shape:
//   { label, onClick, icon?, disabled?, divider? }
// `icon` is a Lucide icon component (e.g. PinIcon from '@lucide/vue'); the menu
// renders it in the row's icon slot. A `divider: true` item is rendered as a
// separator line; other fields ignored.

export interface ContextMenuItem {
  label?: string;
  onClick?: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
  divider?: boolean;
  // A non-interactive small-caps group label (e.g. "Notifications" above a radio
  // group). Rendered as a muted heading row; other fields ignored.
  heading?: string;
}

// A checkbox row: an on/off switch that keeps its label and shows its state
// in the icon slot. `onClick` gets the state to switch to, fixed when the menu
// was built, so a click does what the box showed (#1136).
export function checkboxItem(
  label: string,
  checked: boolean,
  onClick: (next: boolean) => void,
): ContextMenuItem {
  return { label, icon: checked ? SquareCheckIcon : SquareIcon, onClick: () => onClick(!checked) };
}

export interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  // The element that opened the menu, if any. Used by ContextMenu's
  // click-outside listener to recognize a re-click on the same trigger and
  // swallow it — without this, the listener closes the menu but the trigger's
  // own click handler then reopens it on the same gesture, so the menu never
  // toggles closed.
  triggerEl: Element | null;
}

export interface ContextMenuAPI {
  state: ContextMenuState;
  open(items: ContextMenuItem[], x: number, y: number, triggerEl?: Element | null): void;
  close(): void;
}

const state = reactive<ContextMenuState>({
  open: false,
  x: 0,
  y: 0,
  items: [],
  triggerEl: null,
});

function closeMenu(): void {
  state.open = false;
  state.items = [];
  state.triggerEl = null;
}

export function useContextMenu(): ContextMenuAPI {
  return {
    state,
    open(items: ContextMenuItem[], x: number, y: number, triggerEl: Element | null = null): void {
      // Toggle: re-invoking open() from the same trigger while its menu is up
      // closes it. The toggle MUST live here, not in the close-on-outside
      // listener (ContextMenu.vue) — a pointerdown there can't cancel the click
      // that follows, so closing on the trigger's pointerdown just races the
      // trigger's own click and reopens the menu on a single gesture. So the
      // listener ignores the trigger and defers to this reopen path instead.
      if (state.open && triggerEl && state.triggerEl === triggerEl) {
        closeMenu();
        return;
      }
      if (!Array.isArray(items) || items.length === 0) return;
      state.items = items;
      state.x = x;
      state.y = y;
      state.triggerEl = triggerEl;
      state.open = true;
    },
    close(): void {
      closeMenu();
    },
  };
}
