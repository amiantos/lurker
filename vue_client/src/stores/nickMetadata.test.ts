// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(),
}));

import { socketSend } from '../composables/useSocket.js';
import { useNickMetadataStore } from './nickMetadata.js';
import { useNetworksStore } from './networks.js';

const send = vi.mocked(socketSend);

describe('metadata set on other people (#1449)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    send.mockReset();
    send.mockReturnValue(true);
  });

  it('reads the snapshot and answers in any case', () => {
    const store = useNickMetadataStore();
    store.applySnapshot([
      { networkId: 1, nickMetadata: [{ nick: 'Bob', values: { color: '3' } }] },
      { networkId: 2 },
    ]);
    expect(store.valuesFor(1, 'bob')).toEqual({ color: '3' });
    expect(store.valuesFor(1, 'BOB')).toEqual({ color: '3' });
    expect(store.valuesFor(2, 'bob')).toBeNull();
  });

  it("takes the server's record whole, and forgets an empty one", () => {
    const store = useNickMetadataStore();
    store.applyUpdate(1, 'bob', { color: '3', avatar: null });
    store.applyUpdate(1, 'bob', { avatar: null });
    expect(store.valuesFor(1, 'bob')).toEqual({ avatar: null });
    store.applyUpdate(1, 'bob', {});
    expect(store.valuesFor(1, 'bob')).toBeNull();
  });

  it('asks the server and changes nothing until it answers', () => {
    const store = useNickMetadataStore();
    store.set(1, 'bob', 'display-name', null);
    store.reset(1, 'bob', 'color');
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { type: 'set-nick-metadata', networkId: 1, nick: 'bob', key: 'display-name', value: null },
      { type: 'set-nick-metadata', networkId: 1, nick: 'bob', key: 'color', reset: true },
    ]);
    expect(store.valuesFor(1, 'bob')).toBeNull();
  });

  // A `=bob` DCC chat is a conversation with bob (as for nick notes).
  it('treats a DCC chat as its peer', () => {
    const store = useNickMetadataStore();
    store.applyUpdate(1, 'bob', { color: '3' });
    expect(store.valuesFor(1, '=bob')).toEqual({ color: '3' });
    store.set(1, '=bob', 'color', '4');
    expect(send.mock.calls[0][0]).toMatchObject({ nick: 'bob' });
  });

  it('stands in front of the wire record everywhere metadata is read', () => {
    const store = useNickMetadataStore();
    const networks = useNetworksStore();
    networks.applyUserMetadata(1, 'bob', { displayName: 'Bobby', avatarUrl: '/a.png' });
    store.applyUpdate(1, 'bob', { 'display-name': 'Robert', avatar: null, color: '2' });
    expect(networks.metadataFor(1, 'Bob')).toEqual({ displayName: 'Robert', colorSlot: 2 });
    // "Theirs" stays readable for the profile view.
    expect(networks.wireMetadataFor(1, 'bob')).toEqual({
      displayName: 'Bobby',
      avatarUrl: '/a.png',
    });
  });

  it('gives metadata to a nick on a network that has none', () => {
    const store = useNickMetadataStore();
    const networks = useNetworksStore();
    store.applyUpdate(7, 'carol', { 'lurker.chat/tz': 'Asia/Tokyo' });
    expect(networks.metadataFor(7, 'carol')).toEqual({ tz: 'Asia/Tokyo' });
    expect(networks.wireMetadataFor(7, 'carol')).toBeNull();
  });
});
