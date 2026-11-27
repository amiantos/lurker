// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { closedNetworkView, nextOpenNetwork } from './networkAccordion.js';

describe('nextOpenNetwork', () => {
  it('opens the network of the buffer you moved to', () => {
    expect(nextOpenNetwork(null, { networkId: 2, favorite: false })).toBe(2);
    expect(nextOpenNetwork(1, { networkId: 2, favorite: false })).toBe(2);
  });

  it('keeps the last network open on a favorite, wherever it lives', () => {
    expect(nextOpenNetwork(1, { networkId: 2, favorite: true })).toBe(1);
  });

  it('keeps the last network open on the system buffer or nothing', () => {
    expect(nextOpenNetwork(1, { networkId: null, favorite: false })).toBe(1);
    expect(nextOpenNetwork(1, null)).toBe(1);
  });

  it('opens nothing when you start on a favorite', () => {
    expect(nextOpenNetwork(null, { networkId: 2, favorite: true })).toBe(null);
  });
});

describe('closedNetworkView', () => {
  const buf = (target: string, unread = 0, highlighted = 0, muted = false) => ({
    target,
    unread,
    highlighted,
    muted,
  });
  type B = ReturnType<typeof buf>;
  // The list's "full" display mode: a muted row counts highlights only and
  // never colours as unread.
  const rules = {
    count: (b: B) => (b.muted ? b.highlighted : b.unread),
    countsAsUnread: (b: B) => b.unread > 0 && !b.muted,
  };
  const targets = (rows: B[]) => rows.map((r) => r.target);

  it('lists nothing and adds nothing for a quiet network', () => {
    const view = closedNetworkView([buf('#a'), buf('#b')], rules);
    expect(view).toEqual({ rows: [], hiddenCount: 0, hiddenUnread: false });
  });

  it('rolls plain unreads up into the header', () => {
    const view = closedNetworkView([buf('#a', 3), buf('#b', 4), buf('#c')], rules);
    expect(targets(view.rows)).toEqual([]);
    expect(view.hiddenCount).toBe(7);
    expect(view.hiddenUnread).toBe(true);
  });

  it('lists a highlighted buffer and leaves it out of the roll-up', () => {
    const view = closedNetworkView([buf('#a', 3), buf('#b', 5, 1), buf('bob', 2, 2)], rules);
    expect(targets(view.rows)).toEqual(['#b', 'bob']);
    expect(view.hiddenCount).toBe(3);
  });

  it('keeps the listed rows in the order given', () => {
    const view = closedNetworkView([buf('#z', 1, 1), buf('#a', 1, 1)], rules);
    expect(targets(view.rows)).toEqual(['#z', '#a']);
  });

  it('adds nothing for a muted channel with only plain unreads', () => {
    const view = closedNetworkView([buf('#busy', 40, 0, true)], rules);
    expect(view).toEqual({ rows: [], hiddenCount: 0, hiddenUnread: false });
  });
});
