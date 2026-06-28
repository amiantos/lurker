// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { smartSortRows, type SwitcherItem } from './switcherSort.js';

// Build a switcher item; sortKey is derived the way QuickSwitcher does
// (bufferSortKey: leading '#' stripped, lowercased) so alpha tie-breaks read
// naturally from the key.
function item(key: string, opts: Partial<SwitcherItem> = {}): SwitcherItem {
  const target = key.slice(key.indexOf('::') + 2);
  return {
    key,
    pinned: false,
    unread: 0,
    sortKey: target.replace(/^#+/, '').toLowerCase(),
    ...opts,
  };
}

// recencyRank from an ordered key list, most-recent-first (index = rank);
// anything absent is unvisited (Infinity).
function ranker(...mostRecentFirst: string[]) {
  return (key: string) => {
    const i = mostRecentFirst.indexOf(key);
    return i === -1 ? Infinity : i;
  };
}

const keys = (rows: SwitcherItem[]) => rows.map((r) => r.key);

describe('smartSortRows tier precedence', () => {
  it('orders recent → pinned → unread → alphabetical', () => {
    const rows = [
      item('1::#alp'),
      item('1::#unr', { unread: 3 }),
      item('1::#pin', { pinned: true }),
      item('1::#rec'),
    ];
    const out = smartSortRows(rows, { recencyRank: ranker('1::#rec') });
    expect(keys(out)).toEqual(['1::#rec', '1::#pin', '1::#unr', '1::#alp']);
  });

  it('keeps a recently-visited buffer on top even when it is pinned (recency wins)', () => {
    const rows = [item('1::#pin', { pinned: true }), item('1::#rec')];
    // #rec is most recent; #pin is pinned but unvisited this session.
    const out = smartSortRows(rows, { recencyRank: ranker('1::#rec') });
    expect(keys(out)).toEqual(['1::#rec', '1::#pin']);
  });

  it('keeps a recently-visited buffer above unread (recency wins)', () => {
    const rows = [item('1::#unr', { unread: 9 }), item('1::#rec')];
    const out = smartSortRows(rows, { recencyRank: ranker('1::#rec') });
    expect(keys(out)).toEqual(['1::#rec', '1::#unr']);
  });
});

describe('smartSortRows recent tier', () => {
  it('sorts the recent tier most-recently-visited first', () => {
    const rows = [item('1::#a'), item('1::#b'), item('1::#c')];
    // Visited order (most recent first): c, a, b.
    const out = smartSortRows(rows, { recencyRank: ranker('1::#c', '1::#a', '1::#b') });
    expect(keys(out)).toEqual(['1::#c', '1::#a', '1::#b']);
  });
});

describe('smartSortRows pinned tier', () => {
  it('alphabetises unvisited pins (the favourites shelf below recents)', () => {
    const rows = [
      item('1::#zeta', { pinned: true }),
      item('1::#alpha', { pinned: true }),
      item('1::#mu', { pinned: true }),
    ];
    const out = smartSortRows(rows, { recencyRank: ranker() }); // none visited
    expect(keys(out)).toEqual(['1::#alpha', '1::#mu', '1::#zeta']);
  });
});

describe('smartSortRows unread tier', () => {
  it('sorts by unread count descending, then alphabetically', () => {
    const rows = [
      item('1::#m', { unread: 5 }),
      item('1::#k', { unread: 5 }),
      item('1::#c', { unread: 2 }),
    ];
    const out = smartSortRows(rows, { recencyRank: ranker() });
    expect(keys(out)).toEqual(['1::#k', '1::#m', '1::#c']); // 5s tie-broken alpha, then 2
  });
});

describe('smartSortRows alphabetical tier', () => {
  it('alphabetises by the normalised sort key (sigil-stripped, case-folded)', () => {
    const rows = [item('1::#Beta'), item('1::alpha'), item('1::#Gamma')];
    const out = smartSortRows(rows, { recencyRank: ranker() });
    expect(keys(out)).toEqual(['1::alpha', '1::#Beta', '1::#Gamma']);
  });
});
