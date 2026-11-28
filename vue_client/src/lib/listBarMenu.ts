// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The phone's buffer-list top bar keeps four icons (search, activity, saved,
// settings) and folds the rest into a kebab menu (#1484): with DCC and the
// admin panel both showing, eight icons and the logo are wider than a phone.
// These are the folded ones, as the menu's rows. A fixed split, not a measured
// one, so the bar is the same on every phone and for every account.

import { ArchiveIcon, PlusIcon, ShareIcon, ShieldCogIcon } from '@lucide/vue';
import type { ContextMenuItem } from '../composables/useContextMenu.js';

export interface ListBarMenuState {
  /** Shares are off for this account: the row says so, and opens why. */
  sharesOff?: boolean;
  /** The way into the DCC window is offered (the dcc store's entryShown). */
  dcc: boolean;
  /** DCC offers waiting for an answer. */
  dccPending: number;
  admin: boolean;
}

export interface ListBarMenuActions {
  shares: () => void;
  dcc: () => void;
  addNetwork: () => void;
  admin: () => void;
}

export function listBarMenuItems(
  state: ListBarMenuState,
  actions: ListBarMenuActions,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      // Short: a menu row does not wrap, and the reason is a sentence. The
      // row opens the account-limits window, which gives it.
      label: state.sharesOff ? 'Shares (off)' : 'Shares',
      icon: ShareIcon,
      onClick: actions.shares,
    },
  ];
  if (state.dcc) {
    const n = state.dccPending;
    items.push({
      // The bar's DCC icon said this in its colour; a row can say it in words.
      // The count is the one when the menu opened, as every row's label is.
      label: n > 0 ? `DCC — ${n} ${n === 1 ? 'offer' : 'offers'} waiting` : 'DCC',
      icon: ArchiveIcon,
      onClick: actions.dcc,
    });
  }
  items.push({ label: 'Add network', icon: PlusIcon, onClick: actions.addNetwork });
  if (state.admin) {
    items.push({ label: 'Admin panel', icon: ShieldCogIcon, onClick: actions.admin });
  }
  return items;
}
