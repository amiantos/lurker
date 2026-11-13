// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import { canDisconnect, useNetworksStore } from './networks.js';

// The predicate behind every "Disconnect ⟷ Reconnect" control (the network context
// menu and both chat views' server-buffer headers). It is one function precisely so
// those three can't drift back apart.
describe('canDisconnect — which action a network state needs', () => {
  it('offers Disconnect while a network is on the wire', () => {
    expect(canDisconnect('connected')).toBe(true);
  });

  // ⚠⚠ The whole of #785. The retry ladder is unbounded, and it keeps its
  // IrcConnection for the entire outage — so a network pinned against a dead server
  // sits in 'reconnecting' indefinitely. Testing for 'connected' left Reconnect as
  // the only offered action, and Reconnect routes through restartNetwork: it tears
  // the connection down and starts a FRESH loop. There was no reachable stop.
  it('offers Disconnect during a reconnect backoff, which is what stops the loop', () => {
    expect(canDisconnect('reconnecting')).toBe(true);
  });

  // ⚠⚠ Not 'connecting', though it is equally "Lurker is working on it". setState('connecting')
  // fires the moment the socket opens — tens of milliseconds after the POST, well inside a
  // double-click — so a user who clicks Reconnect and impatiently clicks again would hit a
  // button that had already relabelled itself Disconnect and tear down the connection they just
  // asked for. Offering Reconnect there re-fires restartNetwork, which is harmless.
  it('offers Reconnect during a connect, so an impatient double-click is idempotent', () => {
    expect(canDisconnect('connecting')).toBe(false);
  });

  it('offers Reconnect once the network is actually down', () => {
    expect(canDisconnect('disconnected')).toBe(false);
  });

  // A network we have never heard a state for reads as "connect it", not "stop it".
  it('offers Reconnect for an unknown state', () => {
    expect(canDisconnect(undefined)).toBe(false);
    expect(canDisconnect(null)).toBe(false);
    expect(canDisconnect('')).toBe(false);
  });
});

// ⚠⚠ QA: disconnecting the network rendered "=ami|shellter is offline" in a DCC
// chat the user could still type into. A down network's cached presence rows are
// stale, so peerFor synthesizes 'offline' for any nick — correct for a real DM
// peer, exactly backwards for a DCC chat, whose socket is peer-to-peer and keeps
// working while IRC is down. Fixed in the getter rather than in each of the
// sidebar, status bar and profile, because this is where all three agree.
describe('peerFor — a DCC chat target has no presence', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function store(state: string) {
    const s = useNetworksStore();
    s.states[1] = { state } as never;
    return s;
  }

  it('reports no presence for a =nick target on a disconnected network', () => {
    expect(store('disconnected').peerFor(1, '=ami|shellter')).toBeNull();
  });

  it('reports no presence for a =nick target on a connected one either', () => {
    expect(store('connected').peerFor(1, '=bob')).toBeNull();
  });

  // The synthetic offline is still right for a real DM peer — that is the whole
  // point of the getter, and this is what keeps the fix honest.
  it('still reports a real DM peer offline while the network is down', () => {
    expect(store('disconnected').peerFor(1, 'bob')).toMatchObject({ state: 'offline' });
  });
});

// A chat over TLS (#1157) is marked as such for as long as it is live, from
// the snapshot's `dccSecureChats` or the `dcc-chat-state` event's `secure`.
describe('DCC chat state — secure sessions', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('marks a secure session live and secure, and a plain one live only', () => {
    const s = useNetworksStore();
    s.applyDccChatState(1, 'bob', true, true);
    s.applyDccChatState(1, 'alice', true);
    expect(s.isDccChatLive(1, '=bob')).toBe(true);
    expect(s.isDccChatSecure(1, '=bob')).toBe(true);
    expect(s.isDccChatLive(1, '=alice')).toBe(true);
    expect(s.isDccChatSecure(1, '=alice')).toBe(false);
  });

  // The lock is for a live session; the memory of its kind outlives it, so
  // the "not connected" line can suggest the same kind again.
  it('remembers an ended session was secure, until a plain one replaces it', () => {
    const s = useNetworksStore();
    s.applyDccChatState(1, 'bob', true, true);
    s.applyDccChatState(1, 'Bob', false, true);
    expect(s.states[1]!.dccChats).toEqual([]);
    expect(s.isDccChatSecure(1, '=bob')).toBe(false);
    expect(s.wasDccChatSecure(1, '=bob')).toBe(true);
    s.applyDccChatState(1, 'bob', true);
    expect(s.wasDccChatSecure(1, '=bob')).toBe(false);
  });

  // The snapshot lists only LIVE secure sessions, and replaces the state: the
  // memory of an ended one has to be carried over by hand.
  it('keeps the memory across a snapshot, unless it shows a plain session now', () => {
    const s = useNetworksStore();
    s.applyDccChatState(1, 'bob', true, true);
    s.applyDccChatState(1, 'bob', false, true);
    s.applySnapshot([{ networkId: 1, channels: [], dccChats: [], dccSecureChats: [] }]);
    expect(s.wasDccChatSecure(1, '=bob')).toBe(true);
    s.applySnapshot([{ networkId: 1, channels: [], dccChats: ['bob'], dccSecureChats: [] }]);
    expect(s.wasDccChatSecure(1, '=bob')).toBe(false);
    // And a live secure one in the snapshot is not listed twice.
    s.applyDccChatState(1, 'bob', false, true);
    s.applySnapshot([{ networkId: 1, channels: [], dccChats: ['bob'], dccSecureChats: ['bob'] }]);
    expect(s.states[1]!.dccSecureChats).toEqual(['bob']);
  });
});

// IRCv3 metadata (#607): a nick's record, whole, keyed like peerPresence.
describe('user metadata', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('keeps one record per lowercase nick and answers lookups in any case', () => {
    const networks = useNetworksStore();
    networks.applyUserMetadata(1, 'Bob', { displayName: 'Bob the Builder', avatarUrl: null });
    expect(networks.metadataFor(1, 'bob')).toEqual({
      displayName: 'Bob the Builder',
      avatarUrl: null,
    });
    expect(networks.metadataFor(1, 'BOB')?.displayName).toBe('Bob the Builder');
    expect(networks.metadataFor(2, 'bob')).toBeNull();
    expect(networks.metadataFor(null, 'bob')).toBeNull();
  });

  it('replaces the record whole, and forgets on null (a rename sends both)', () => {
    const networks = useNetworksStore();
    networks.applyUserMetadata(1, 'bob', { displayName: 'Bob', pronouns: 'he/him' });
    networks.applyUserMetadata(1, 'bob', { pronouns: 'he/him' });
    expect(networks.metadataFor(1, 'bob')).toEqual({ pronouns: 'he/him' });
    networks.applyUserMetadata(1, 'bob', null);
    networks.applyUserMetadata(1, 'bob2', { pronouns: 'he/him' });
    expect(networks.metadataFor(1, 'bob')).toBeNull();
    expect(networks.metadataFor(1, 'bob2')).toEqual({ pronouns: 'he/him' });
  });

  it('is seeded by the snapshot', () => {
    const networks = useNetworksStore();
    networks.applySnapshot([
      {
        networkId: 1,
        channels: [],
        userMetadata: { carol: { displayName: 'Carol' } },
        metadataLimits: { maxSubs: 10, maxKeys: 10, maxValueBytes: 512, beforeConnect: false },
      } as never,
    ]);
    expect(networks.metadataFor(1, 'Carol')).toEqual({ displayName: 'Carol' });
    expect(networks.states[1]?.metadataLimits?.maxSubs).toBe(10);
  });
});

describe('messages held in the send queue (#1326)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const held = (id: string, target = '#c') => ({
    networkId: 1,
    target: ':server:',
    pending: { id, target, kind: 'privmsg', text: `text ${id}`, at: '2026-11-13T12:00:00.000Z' },
  });
  const ids = (store: ReturnType<typeof useNetworksStore>) =>
    (store.states[1]?.sendPending ?? []).map((p) => p.id);

  it('keeps each held message once, in the order they came', () => {
    const store = useNetworksStore();
    store.applySendPending(held('a'));
    store.applySendPending(held('b'));
    store.applySendPending(held('a'));
    expect(ids(store)).toEqual(['a', 'b']);
    expect(store.states[1].sendPending?.[0]).toMatchObject({ target: '#c', text: 'text a' });
  });

  it('removes one when the server says its wait is over, sent or not', () => {
    const store = useNetworksStore();
    store.applySendPending(held('a'));
    store.applySendPending(held('b'));
    store.applySendPendingDone({ networkId: 1, pendingId: 'a', sent: false });
    expect(ids(store)).toEqual(['b']);
    store.applySendPendingDone({ networkId: 1, pendingId: 'unknown', sent: true });
    expect(ids(store)).toEqual(['b']);
    store.applySendPendingDone({ networkId: 1, pendingId: 'b', sent: true });
    expect(ids(store)).toEqual([]);
  });
});
