// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { flattenBufferOrder, flattenUnreadOrder, FRIENDS_GROUP_ID } from './bufferOrder.js';

// Lightweight duck-typed fakes matching the store interfaces bufferOrder reads.
function makeBuffers(byNetwork: Record<string, string[]>, unread: Record<string, number> = {}) {
  return {
    forNetwork: (id: string | number) =>
      (byNetwork[String(id)] || []).map((target) => ({ target })),
    byKey: (key: string) => (key in unread ? { unread: unread[key] } : null),
  };
}
function makePins(byNetwork: Record<string, string[]>) {
  return { forNetwork: (id: string | number) => byNetwork[String(id)] ?? null };
}

// The activeKey of a network's server pseudo-buffer: `${id}::` + `:server:${id}`,
// i.e. a triple colon (network id, `::` separator, `:server:<id>` target).
const srvKey = (id: number) => `${id}:::server:${id}`;

describe('flattenBufferOrder', () => {
  it('orders each network: server first, pinned (stored order), then channels then DMs alphabetically', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }, { id: 2 }],
      buffers: makeBuffers({
        '1': ['#zeta', '#alpha', 'bob', 'amy', '#pinned', 'dm_pinned'],
        '2': ['#chan2'],
      }),
      pins: makePins({ '1': ['#pinned', 'dm_pinned'] }),
    });
    expect(order.map((e) => e.key)).toEqual([
      srvKey(1),
      '1::#pinned',
      '1::dm_pinned',
      '1::#alpha',
      '1::#zeta',
      '1::amy',
      '1::bob',
      srvKey(2),
      '2::#chan2',
    ]);
    // Every real entry nav-groups by its own network id.
    expect(order.every((e) => e.groupId === e.networkId)).toBe(true);
  });

  it('ignores pinned targets that no longer exist as buffers', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['#real'] }),
      pins: makePins({ '1': ['#ghost', '#real'] }), // #ghost has no buffer
    });
    expect(order.map((e) => e.target)).toEqual([':server:1', '#real']);
  });

  it('injects the FRIENDS group first (feed header + friend DMs) under FRIENDS_GROUP_ID', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['#chan', 'bob'] }),
      pins: makePins({}),
      friends: {
        feedKey: ':friends:',
        dms: [{ networkId: 1, target: 'bob' }],
        excludeKeys: new Set(['1::bob']),
      },
    });
    expect(order.slice(0, 2)).toEqual([
      {
        networkId: FRIENDS_GROUP_ID,
        target: ':friends:',
        key: ':friends:',
        groupId: FRIENDS_GROUP_ID,
      },
      { networkId: 1, target: 'bob', key: '1::bob', groupId: FRIENDS_GROUP_ID },
    ]);
    // bob is excluded from its real network so it isn't walked twice.
    const realNetKeys = order.filter((e) => e.groupId === 1).map((e) => e.target);
    expect(realNetKeys).toEqual([':server:1', '#chan']);
  });

  it('excludeKeys matching is case-insensitive on the nick', () => {
    const order = flattenBufferOrder({
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['Bob'] }), // server-cased nick
      pins: makePins({}),
      friends: {
        feedKey: ':friends:',
        dms: [{ networkId: 1, target: 'Bob' }],
        excludeKeys: new Set(['1::bob']),
      },
    });
    // Only the friends-group Bob remains; the real-network one is excluded.
    expect(order.filter((e) => e.groupId === 1).map((e) => e.target)).toEqual([':server:1']);
  });
});

describe('flattenUnreadOrder', () => {
  it('keeps only entries whose buffer has unread > 0, server pseudo-buffers included', () => {
    const args = {
      networks: [{ id: 1 }],
      buffers: makeBuffers(
        { '1': ['#busy', '#quiet'] },
        { '1::#busy': 3, '1::#quiet': 0, [srvKey(1)]: 1 },
      ),
      pins: makePins({}),
    };
    expect(flattenUnreadOrder(args).map((e) => e.key)).toEqual([srvKey(1), '1::#busy']);
  });

  it('drops the virtual FRIENDS feed (no backing buffer / never unread)', () => {
    const args = {
      networks: [{ id: 1 }],
      buffers: makeBuffers({ '1': ['#busy'] }, { '1::#busy': 2 }),
      pins: makePins({}),
      friends: { feedKey: ':friends:', dms: [] as Array<{ networkId: number; target: string }> },
    };
    const keys = flattenUnreadOrder(args).map((e) => e.key);
    expect(keys).not.toContain(':friends:');
    expect(keys).toEqual(['1::#busy']);
  });
});
