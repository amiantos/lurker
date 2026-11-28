// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it, vi } from 'vitest';
import { listBarMenuItems, type ListBarMenuActions } from './listBarMenu.js';

const actions = (): ListBarMenuActions => ({
  shares: vi.fn<() => void>(),
  dcc: vi.fn<() => void>(),
  addNetwork: vi.fn<() => void>(),
  admin: vi.fn<() => void>(),
});
const labels = (state: Parameters<typeof listBarMenuItems>[0]) =>
  listBarMenuItems(state, actions()).map((i) => i.label);

describe('the buffer-list bar menu (#1484)', () => {
  it('always offers shares and add network', () => {
    expect(labels({ dcc: false, dccPending: 0, admin: false })).toEqual(['Shares', 'Add network']);
  });

  it('adds DCC and the admin panel for the accounts that have them', () => {
    expect(labels({ dcc: true, dccPending: 0, admin: true })).toEqual([
      'Shares',
      'DCC',
      'Add network',
      'Admin panel',
    ]);
  });

  it('says how many DCC offers are waiting', () => {
    expect(labels({ dcc: true, dccPending: 1, admin: false })[1]).toBe('DCC — 1 offer waiting');
    expect(labels({ dcc: true, dccPending: 3, admin: false })[1]).toBe('DCC — 3 offers waiting');
  });

  it('runs the action of the row that was picked', () => {
    const a = actions();
    const items = listBarMenuItems({ dcc: true, dccPending: 0, admin: true }, a);
    for (const item of items) item.onClick?.();
    expect(a.shares).toHaveBeenCalledTimes(1);
    expect(a.dcc).toHaveBeenCalledTimes(1);
    expect(a.addNetwork).toHaveBeenCalledTimes(1);
    expect(a.admin).toHaveBeenCalledTimes(1);
  });
});
