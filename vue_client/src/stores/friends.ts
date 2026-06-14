// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { socketSend } from '../composables/useSocket.js';
import { useNetworksStore } from './networks.js';
import { useBuffersStore } from './buffers.js';
import type { BufferMessage } from './buffers.js';
import { isPeerOnline, isPeerAway, isPeerOffline } from '../utils/peerPresence.js';
import { FRIENDS_KEY } from '../lib/virtualBuffers.js';

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

// Case-insensitive alphabetical by display name. Array sort is stable, so
// equal names keep their prior relative order.
function byDisplayName(a: Contact, b: Contact): number {
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
}

export type FriendPresence = 'online' | 'away' | 'offline' | 'unknown';

// The presence row (online/away/offline/back) for one target, or null when
// unknown (network without MONITOR + no shared channel).
function targetPresence(
  networks: ReturnType<typeof useNetworksStore>,
  t: ContactTarget,
): { state: string | null } | null {
  return (networks.states as any)[t.networkId]?.peerPresence?.[t.nick.toLowerCase()] ?? null;
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
    // Best presence across a friend's targets: online wins, then away, then a
    // definitive offline; all-unknown stays 'unknown' (renders un-muted, like a
    // DM row with no presence). Drives the FRIENDS row tint.
    presenceState:
      (state) =>
      (contactId: number): FriendPresence => {
        const networks = useNetworksStore();
        const c = state.contacts.find((x) => x.id === contactId);
        if (!c) return 'unknown';
        const rows = c.targets.map((t) => targetPresence(networks, t));
        if (rows.some(isPeerOnline)) return 'online';
        if (rows.some(isPeerAway)) return 'away';
        if (rows.some(isPeerOffline)) return 'offline';
        return 'unknown';
      },
    // Definitively online on at least one target — used for the header count.
    isOnline:
      (state) =>
      (contactId: number): boolean => {
        const networks = useNetworksStore();
        const c = state.contacts.find((x) => x.id === contactId);
        return !!c && c.targets.map((t) => targetPresence(networks, t)).some(isPeerOnline);
      },
    // `${networkId}::${nickLower}` for every contact's PRIMARY target — the DMs
    // surfaced under FRIENDS, so BufferList hides them from their real network.
    primaryDmKeys: (state): Set<string> => {
      const set = new Set<string>();
      for (const c of state.contacts) {
        const t = primaryTargetOf(c);
        if (t) set.add(`${t.networkId}::${t.nick.toLowerCase()}`);
      }
      return set;
    },
    // Ordered { networkId, target } for each friend's primary DM, in sidebar
    // (contacts) order, with the target resolved to an existing DM buffer's case
    // when one is open. Used by keyboard nav / quick-switch so the FRIENDS rows
    // walk in the same order they render.
    primaryDmEntries(state): Array<{ networkId: number; target: string }> {
      const buffers = useBuffersStore();
      const out: Array<{ networkId: number; target: string }> = [];
      for (const c of state.contacts) {
        const t = primaryTargetOf(c);
        if (!t) continue;
        const lower = t.nick.toLowerCase();
        const existing = buffers
          .forNetwork(t.networkId)
          .find(
            (b) =>
              b.target.toLowerCase() === lower &&
              !b.target.startsWith('#') &&
              !b.target.startsWith(':'),
          );
        out.push({ networkId: t.networkId, target: existing ? existing.target : t.nick });
      }
      return out;
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
    // Kept sorted alphabetically by display name (case-insensitive) on every
    // change, so adding/editing a friend doesn't drop them at the end. Presence
    // for the rows is derived live from peerPresence, so the list just holds
    // identity + targets.
    applySnapshot(contacts: Contact[]) {
      this.contacts = (contacts || []).map(normalizeContact).toSorted(byDisplayName);
    },
    applyContactUpdated(contact: Contact) {
      const c = normalizeContact(contact);
      const others = this.contacts.filter((x) => x.id !== c.id);
      this.contacts = [...others, c].toSorted(byDisplayName);
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
    // Open the FRIENDS feed buffer: select it, ensure it exists, and lazily
    // fetch the first page. Shared by the sidebar header click and keyboard nav.
    activateFeed() {
      useNetworksStore().activateVirtual(FRIENDS_KEY);
      useBuffersStore().ensureFriendsBuffer();
      if (!this.loaded) this.loadFeed();
    },
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
