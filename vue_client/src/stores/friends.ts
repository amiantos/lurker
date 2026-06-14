// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { socketSend } from '../composables/useSocket.js';
import { useNetworksStore } from './networks.js';
import { useBuffersStore } from './buffers.js';
import type { BufferMessage } from './buffers.js';

// Friends / contacts. The server is the source of truth: contacts ship in the
// `contacts-snapshot` on connect and `contact-updated`/`contact-deleted` echoes
// keep every tab in sync. This store owns:
//   - the contact list + the Configure-Friend modal editor state,
//   - the synthetic nicklist for the :friends: buffer (contacts × presence),
//   - the cross-network feed loader (REST /api/friends-feed), which prefixes
//     each row with [network/#channel] and pushes it into the :friends: buffer.

const PAGE_SIZE = 200;

export interface ContactTarget {
  networkId: number;
  nick: string;
  isPrimary: boolean;
}

export interface Contact {
  id: number;
  displayName: string;
  notifyOnline: boolean;
  targets: ContactTarget[];
}

// The target whose DM opens when the friend is clicked in the FRIENDS group:
// the one flagged primary, else the first. Null only for a target-less contact.
export function primaryTargetOf(contact: Contact): ContactTarget | null {
  return contact.targets.find((t) => t.isPrimary) ?? contact.targets[0] ?? null;
}

export interface FriendEditorState {
  open: boolean;
  contact: Contact | null; // set when editing an existing contact
  prefill: { networkId: number; nick: string } | null; // set when adding from a nick
}

// A friend is "online" if ANY of their watched targets reports online/back.
function targetOnline(networks: ReturnType<typeof useNetworksStore>, t: ContactTarget): boolean {
  const state = (networks.states as any)[t.networkId]?.peerPresence?.[t.nick.toLowerCase()]?.state;
  return state === 'online' || state === 'back';
}

export const useFriendsStore = defineStore('friends', {
  state: () => ({
    contacts: [] as Contact[],
    editor: { open: false, contact: null, prefill: null } as FriendEditorState,
    // Feed pagination state (mirrors the highlights store).
    nextBefore: null as number | null,
    loading: false,
    loaded: false,
    error: '',
  }),
  getters: {
    // A friend's "online anywhere" status, by contact id — drives nicklist tint.
    isOnline:
      (state) =>
      (contactId: number): boolean => {
        const networks = useNetworksStore();
        const c = state.contacts.find((x) => x.id === contactId);
        return !!c && c.targets.some((t) => targetOnline(networks, t));
      },
    // The contact (if any) watching (networkId, nick) — drives the nick menu's
    // Add/Edit Friend label.
    contactForTarget:
      (state) =>
      (networkId: number, nick: string): Contact | null => {
        const lower = (nick || '').toLowerCase();
        return (
          state.contacts.find((c) =>
            c.targets.some((t) => t.networkId === networkId && t.nick.toLowerCase() === lower),
          ) || null
        );
      },
    // Find a contact watching (networkId, nick) whose notify flag is on — used
    // by the came-online toast gate.
    notifyContactFor:
      (state) =>
      (networkId: number, nick: string): Contact | null => {
        const lower = (nick || '').toLowerCase();
        return (
          state.contacts.find(
            (c) =>
              c.notifyOnline &&
              c.targets.some((t) => t.networkId === networkId && t.nick.toLowerCase() === lower),
          ) || null
        );
      },
  },
  actions: {
    // ---- snapshot + live sync ----
    // Presence for the FRIENDS sidebar rows is derived live from peerPresence
    // via the isOnline getter, so contact changes just replace the list.
    applySnapshot(contacts: Contact[]) {
      this.contacts = (contacts || []).map(normalizeContact);
    },
    applyContactUpdated(contact: Contact) {
      const c = normalizeContact(contact);
      const idx = this.contacts.findIndex((x) => x.id === c.id);
      if (idx >= 0) this.contacts[idx] = c;
      else this.contacts.push(c);
    },
    applyContactDeleted(contactId: number) {
      this.contacts = this.contacts.filter((c) => c.id !== contactId);
    },

    // ---- editor (Configure Friend modal) ----
    openEditorForNick(networkId: number | string, nick: string) {
      const nid = Number(networkId);
      const lower = (nick || '').toLowerCase();
      // If a contact already watches this (network, nick), edit it; else create.
      const existing = this.contacts.find((c) =>
        c.targets.some((t) => t.networkId === nid && t.nick.toLowerCase() === lower),
      );
      this.editor = existing
        ? { open: true, contact: existing, prefill: null }
        : { open: true, contact: null, prefill: { networkId: nid, nick } };
    },
    openEditorForContact(contact: Contact) {
      this.editor = { open: true, contact: normalizeContact(contact), prefill: null };
    },
    closeEditor() {
      this.editor = { open: false, contact: null, prefill: null };
    },
    saveContact(payload: {
      contactId?: number | null;
      displayName: string;
      notifyOnline: boolean;
      targets: Array<{ networkId: number; nick: string }>;
      primaryNetworkId: number | null;
    }) {
      socketSend({
        type: 'set-contact',
        contactId: payload.contactId ?? null,
        displayName: payload.displayName,
        notifyOnline: payload.notifyOnline,
        targets: payload.targets,
        primaryNetworkId: payload.primaryNetworkId,
      });
    },
    removeContact(contactId: number) {
      socketSend({ type: 'delete-contact', contactId });
    },

    // ---- feed (cross-network friend messages) ----
    // Initial load: newest page from REST (descending), reversed to ascending,
    // prefixed, and seeded into the :friends: buffer.
    async loadFeed() {
      this.loading = true;
      this.error = '';
      try {
        const { items, nextBefore } = await api(`/api/friends-feed?limit=${PAGE_SIZE}`);
        const ascending = (items || []).toReversed().map((row: any) => this.prefixRow(row));
        useBuffersStore().setFriendMessages(ascending);
        this.nextBefore = nextBefore ?? null;
        this.loaded = true;
      } catch (e: any) {
        this.error = e.message || 'failed to load friends feed';
      } finally {
        this.loading = false;
      }
    },
    // Append one live friend message (an irc event already flagged friend:true).
    applyLiveMessage(event: any) {
      useBuffersStore().pushFriendMessage(this.prefixRow(event));
    },
    // Prepend the [network/#channel] origin to a row's text. Operates on a copy
    // so the message in its real buffer keeps its original text.
    prefixRow(row: any): BufferMessage {
      const networks = useNetworksStore();
      const name =
        row.networkName || networks.networkById(row.networkId)?.name || `net:${row.networkId}`;
      const origin = `[${name}/${row.target}] `;
      const text = typeof row.text === 'string' ? row.text : '';
      return { ...row, text: origin + text } as BufferMessage;
    },
  },
});

function normalizeContact(c: Contact): Contact {
  return {
    id: c.id,
    displayName: c.displayName,
    notifyOnline: !!c.notifyOnline,
    targets: Array.isArray(c.targets)
      ? c.targets.map((t) => ({
          networkId: Number(t.networkId),
          nick: t.nick,
          isPrimary: !!t.isPrimary,
        }))
      : [],
  };
}
