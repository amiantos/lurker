// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { closedNetworkView, isNetworkOpen, stepVisit } from './networkAccordion.js';

describe('stepVisit', () => {
  const none = { open: null, last: null };
  const at = (networkId: number | null, favorite = false) => ({ networkId, favorite });

  it('opens the network you arrive in', () => {
    expect(stepVisit(none, at(2))).toEqual({ open: 2, last: 2 });
    expect(stepVisit({ open: 1, last: 1 }, at(2))).toEqual({ open: 2, last: 2 });
  });

  it('changes nothing on a favorite, wherever it lives', () => {
    const state = { open: 1, last: 1 };
    expect(stepVisit(state, at(2, true))).toBe(state);
  });

  it('changes nothing on the system buffer or with no buffer', () => {
    const state = { open: 1, last: 1 };
    expect(stepVisit(state, at(null))).toBe(state);
    expect(stepVisit(state, null)).toBe(state);
  });

  it('opens nothing when you start on a favorite', () => {
    expect(stepVisit(none, at(2, true))).toEqual(none);
  });

  // The chevron ended the visit: moving on inside the network is not arriving.
  it('leaves an ended visit ended while you stay in the network', () => {
    const ended = { open: null, last: 1 };
    expect(stepVisit(ended, at(1))).toBe(ended);
  });

  it('starts a new visit when you come back from another network', () => {
    const away = stepVisit({ open: null, last: 1 }, at(2));
    expect(stepVisit(away, at(1))).toEqual({ open: 1, last: 1 });
  });
});

describe('isNetworkOpen', () => {
  const net = (over: Partial<Parameters<typeof isNetworkOpen>[0]> = {}) =>
    isNetworkOpen({ id: 1, collapsed: false, accordion: false, openNetworkId: null, ...over });

  it('is open by default', () => {
    expect(net()).toBe(true);
  });

  it('is closed once folded by hand', () => {
    expect(net({ collapsed: true })).toBe(false);
    expect(net({ collapsed: true, openNetworkId: 2 })).toBe(false);
  });

  it('shows a folded network open for a visit', () => {
    expect(net({ collapsed: true, openNetworkId: 1 })).toBe(true);
  });

  it('closes every network but the visited one in accordion mode', () => {
    expect(net({ accordion: true })).toBe(false);
    expect(net({ accordion: true, openNetworkId: 2 })).toBe(false);
    expect(net({ accordion: true, openNetworkId: 1 })).toBe(true);
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
  let active = '';
  const rules = {
    count: (b: B) => (b.muted ? b.highlighted : b.unread),
    countsAsUnread: (b: B) => b.unread > 0 && !b.muted,
    isActive: (b: B) => b.target === active,
  };
  beforeEach(() => (active = ''));
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

  it('lists the buffer you are in, alone', () => {
    active = '#b';
    const view = closedNetworkView([buf('#a', 3), buf('#b'), buf('#c')], rules);
    expect(targets(view.rows)).toEqual(['#b']);
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
