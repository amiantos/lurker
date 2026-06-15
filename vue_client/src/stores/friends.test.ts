// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// friends.ts reaches into the socket + the networks/buffers stores. Mock those
// so this exercises the store's own logic (sync, editor, presence/order getters)
// without standing up a WebSocket or the rest of the store graph. Shared mutable
// fakes live in vi.hoisted so the (hoisted) vi.mock factories can see them.
const h = vi.hoisted(() => ({
  socketSend: vi.fn<(payload: unknown) => void>(),
  peerRows: new Map<string, { state: string | null }>(),
  dmBuffers: new Map<string, { target: string }>(),
  activateVirtual: vi.fn<(key: string) => void>(),
  activate: vi.fn<(networkId: number, target: string) => void>(),
}));

vi.mock('../composables/useSocket.js', () => ({ socketSend: h.socketSend }));
vi.mock('./networks.js', () => ({
  useNetworksStore: () => ({
    peerFor: (networkId: number, nick: string) =>
      h.peerRows.get(`${networkId}::${String(nick).toLowerCase()}`) ?? null,
    activateVirtual: h.activateVirtual,
  }),
}));
vi.mock('./buffers.js', () => ({
  useBuffersStore: () => ({
    findDm: (networkId: number, nick: string) =>
      h.dmBuffers.get(`${networkId}::${String(nick).toLowerCase()}`) ?? null,
    activate: h.activate,
  }),
}));

import { useFriendsStore, primaryTargetOf, type Contact } from './friends.js';
import { FRIENDS_KEY } from '../lib/virtualBuffers.js';

function contact(over: Partial<Contact> & { id: number; displayName: string }): Contact {
  return { notifyOnline: false, targets: [], ...over };
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.socketSend.mockClear();
  h.activateVirtual.mockClear();
  h.activate.mockClear();
  h.peerRows.clear();
  h.dmBuffers.clear();
});

describe('primaryTargetOf', () => {
  it('returns the flagged primary, else the first target, else null', () => {
    expect(
      primaryTargetOf(
        contact({
          id: 1,
          displayName: 'A',
          targets: [
            { networkId: 1, nick: 'first', isPrimary: false },
            { networkId: 1, nick: 'second', isPrimary: true },
          ],
        }),
      ),
    ).toEqual({ networkId: 1, nick: 'second', isPrimary: true });
    expect(
      primaryTargetOf(
        contact({
          id: 2,
          displayName: 'B',
          targets: [{ networkId: 1, nick: 'only', isPrimary: false }],
        }),
      ),
    ).toEqual({ networkId: 1, nick: 'only', isPrimary: false });
    expect(primaryTargetOf(contact({ id: 3, displayName: 'C', targets: [] }))).toBeNull();
  });
});

describe('snapshot + live sync', () => {
  it('applySnapshot normalizes types and sorts case-insensitively by display name', () => {
    const store = useFriendsStore();
    store.applySnapshot([
      // notifyOnline as 1, networkId as a string, isPrimary as 0/1 — wire shapes.
      {
        id: 2,
        displayName: 'bob',
        notifyOnline: 1,
        targets: [{ networkId: '5', nick: 'b', isPrimary: 1 }],
      },
      { id: 1, displayName: 'Alice', notifyOnline: 0, targets: [] },
    ] as unknown as Contact[]);
    expect(store.contacts.map((c) => c.displayName)).toEqual(['Alice', 'bob']);
    const bob = store.contacts.find((c) => c.id === 2)!;
    expect(bob.notifyOnline).toBe(true);
    expect(bob.targets[0]).toEqual({ networkId: 5, nick: 'b', isPrimary: true });
  });

  it('applyContactUpdated inserts new contacts and replaces existing ones, re-sorting', () => {
    const store = useFriendsStore();
    store.applySnapshot([contact({ id: 1, displayName: 'Alice' })]);
    store.applyContactUpdated(contact({ id: 2, displayName: 'Aaron' }));
    expect(store.contacts.map((c) => c.displayName)).toEqual(['Aaron', 'Alice']);
    store.applyContactUpdated(contact({ id: 1, displayName: 'Zara' }));
    expect(store.contacts.map((c) => c.displayName)).toEqual(['Aaron', 'Zara']);
    expect(store.contacts).toHaveLength(2);
  });

  it('applyContactDeleted removes by id', () => {
    const store = useFriendsStore();
    store.applySnapshot([
      contact({ id: 1, displayName: 'A' }),
      contact({ id: 2, displayName: 'B' }),
    ]);
    store.applyContactDeleted(1);
    expect(store.contacts.map((c) => c.id)).toEqual([2]);
  });
});

describe('lookup getters', () => {
  function seed() {
    const store = useFriendsStore();
    store.applySnapshot([
      contact({
        id: 1,
        displayName: 'Alice',
        notifyOnline: true,
        targets: [
          { networkId: 1, nick: 'Alice', isPrimary: true },
          { networkId: 2, nick: 'al', isPrimary: false },
        ],
      }),
      contact({
        id: 2,
        displayName: 'Bob',
        notifyOnline: false,
        targets: [{ networkId: 1, nick: 'Bob', isPrimary: true }],
      }),
    ]);
    return store;
  }

  it('contactById / contactByTarget index every target case-insensitively', () => {
    const store = seed();
    expect(store.contactById.get(2)!.displayName).toBe('Bob');
    expect(store.contactByTarget.get('1::alice')!.id).toBe(1);
    expect(store.contactByTarget.get('2::al')!.id).toBe(1);
    expect(store.contactForTarget(1, 'BOB')!.id).toBe(2);
    expect(store.contactForTarget(1, 'nobody')).toBeNull();
  });

  it('primaryDmKeys covers only each contact primary target, lowercased', () => {
    const store = seed();
    expect([...store.primaryDmKeys].toSorted()).toEqual(['1::alice', '1::bob']);
  });

  it('notifyContactFor only matches targets whose contact has notifyOnline on', () => {
    const store = seed();
    expect(store.notifyContactFor(1, 'alice')!.id).toBe(1);
    expect(store.notifyContactFor(1, 'bob')).toBeNull(); // Bob has notify off
    expect(store.notifyContactFor(2, 'al')!.id).toBe(1); // secondary target still counts
  });
});

describe('presence getters', () => {
  it('primaryPresence derives from the primary target row (online/away/offline/unknown)', () => {
    const store = useFriendsStore();
    store.applySnapshot([
      contact({
        id: 1,
        displayName: 'On',
        targets: [{ networkId: 1, nick: 'on', isPrimary: true }],
      }),
      contact({
        id: 2,
        displayName: 'Away',
        targets: [{ networkId: 1, nick: 'aw', isPrimary: true }],
      }),
      contact({
        id: 3,
        displayName: 'Off',
        targets: [{ networkId: 1, nick: 'off', isPrimary: true }],
      }),
      contact({
        id: 4,
        displayName: 'Unk',
        targets: [{ networkId: 1, nick: 'unk', isPrimary: true }],
      }),
      contact({ id: 5, displayName: 'None', targets: [] }),
    ]);
    h.peerRows.set('1::on', { state: 'back' }); // 'back' counts as online
    h.peerRows.set('1::aw', { state: 'away' });
    h.peerRows.set('1::off', { state: 'offline' });
    // 'unk' has no row → unknown.
    expect(store.primaryPresence(1)).toBe('online');
    expect(store.primaryPresence(2)).toBe('away');
    expect(store.primaryPresence(3)).toBe('offline');
    expect(store.primaryPresence(4)).toBe('unknown');
    expect(store.primaryPresence(5)).toBe('unknown'); // target-less
    expect(store.primaryPresence(999)).toBe('unknown'); // unknown contact
  });

  it('presenceForTarget reads an arbitrary (network, nick) row', () => {
    const store = useFriendsStore();
    h.peerRows.set('2::carol', { state: 'online' });
    expect(store.presenceForTarget(2, 'Carol')).toBe('online');
    expect(store.presenceForTarget(2, 'dave')).toBe('unknown');
  });

  it('primaryDmEntries resolves to an open DM buffer case when one exists', () => {
    const store = useFriendsStore();
    store.applySnapshot([
      contact({
        id: 1,
        displayName: 'A',
        targets: [{ networkId: 1, nick: 'Alice', isPrimary: true }],
      }),
      contact({
        id: 2,
        displayName: 'B',
        targets: [{ networkId: 1, nick: 'Bob', isPrimary: true }],
      }),
    ]);
    // Alice has an open DM whose buffer target is the server-cased 'alice'.
    h.dmBuffers.set('1::alice', { target: 'alice' });
    expect(store.primaryDmEntries).toEqual([
      { networkId: 1, target: 'alice' }, // resolved to existing buffer case
      { networkId: 1, target: 'Bob' }, // no open buffer → the contact's nick
    ]);
  });
});

describe('editor state', () => {
  it('openEditorForNick edits the matching contact, else prefills a new one', () => {
    const store = useFriendsStore();
    store.applySnapshot([
      contact({
        id: 7,
        displayName: 'Existing',
        targets: [{ networkId: 1, nick: 'Watched', isPrimary: true }],
      }),
    ]);
    store.openEditorForNick('1', 'watched'); // case-insensitive + string networkId
    expect(store.editor).toEqual({
      open: true,
      contact: expect.objectContaining({ id: 7 }),
      prefill: null,
    });
    store.openEditorForNick(2, 'stranger');
    expect(store.editor).toEqual({
      open: true,
      contact: null,
      prefill: { networkId: 2, nick: 'stranger' },
    });
  });

  it('openEditorNew / openEditorForContact / closeEditor set the expected state', () => {
    const store = useFriendsStore();
    store.openEditorNew();
    expect(store.editor).toEqual({ open: true, contact: null, prefill: null });
    store.openEditorForContact(contact({ id: 3, displayName: 'C' }));
    expect(store.editor.open).toBe(true);
    expect(store.editor.contact!.id).toBe(3);
    store.closeEditor();
    expect(store.editor).toEqual({ open: false, contact: null, prefill: null });
  });
});

describe('socket-backed mutations', () => {
  it('saveContact emits a set-contact frame with the normalized payload', () => {
    const store = useFriendsStore();
    store.saveContact({
      contactId: 5,
      displayName: 'X',
      notifyOnline: true,
      targets: [{ networkId: 1, nick: 'x', isPrimary: true }],
    });
    expect(h.socketSend).toHaveBeenCalledWith({
      type: 'set-contact',
      contactId: 5,
      displayName: 'X',
      notifyOnline: true,
      targets: [{ networkId: 1, nick: 'x', isPrimary: true }],
    });
  });

  it('saveContact defaults a missing contactId to null (create)', () => {
    const store = useFriendsStore();
    store.saveContact({ displayName: 'New', notifyOnline: false, targets: [] });
    expect(h.socketSend).toHaveBeenCalledWith(expect.objectContaining({ contactId: null }));
  });

  it('removeContact emits a delete-contact frame', () => {
    const store = useFriendsStore();
    store.removeContact(9);
    expect(h.socketSend).toHaveBeenCalledWith({ type: 'delete-contact', contactId: 9 });
  });
});

describe('navigation actions', () => {
  it('open activates the FRIENDS virtual buffer', () => {
    useFriendsStore().open();
    expect(h.activateVirtual).toHaveBeenCalledWith(FRIENDS_KEY);
  });

  it('openDmTarget activates the existing buffer case when one is open', () => {
    const store = useFriendsStore();
    h.dmBuffers.set('1::alice', { target: 'Alice' });
    store.openDmTarget(1, 'alice');
    expect(h.activate).toHaveBeenCalledWith(1, 'Alice');
    store.openDmTarget(2, 'fresh');
    expect(h.activate).toHaveBeenLastCalledWith(2, 'fresh'); // no buffer → raw nick
  });

  it('openDm opens the primary DM, or the editor for a target-less contact', () => {
    const store = useFriendsStore();
    store.openDm(
      contact({ id: 1, displayName: 'A', targets: [{ networkId: 1, nick: 'a', isPrimary: true }] }),
    );
    expect(h.activate).toHaveBeenCalledWith(1, 'a');

    const orphan = contact({ id: 2, displayName: 'Orphan', targets: [] });
    store.openDm(orphan);
    expect(store.editor.open).toBe(true);
    expect(store.editor.contact!.id).toBe(2);
  });
});
