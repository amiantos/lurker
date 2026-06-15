// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import { useNetworksStore } from './networks.js';
import { useBuffersStore } from './buffers.js';
import { isPeerOnline, isPeerAway, isPeerOffline } from '../utils/peerPresence.js';
import { FRIENDS_KEY } from '../lib/virtualBuffers.js';

// Friends / contacts. The server is the source of truth: contacts ship in the
// `contacts-snapshot` on connect and `contact-updated`/`contact-deleted` echoes
// keep every tab in sync. This store owns the contact list, the Configure-Friend
// modal editor state, and the presence/ordering getters the FRIENDS UI reads.

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

// Presence rows come from networks.peerFor (the single disconnected-aware
// source): a down network reads 'offline', connected-but-no-row stays null
// (unknown = "potentially online", the no-MONITOR case).
function deriveState(row: { state: string | null } | null): FriendPresence {
  if (isPeerOnline(row)) return 'online';
  if (isPeerAway(row)) return 'away';
  if (isPeerOffline(row)) return 'offline';
  return 'unknown';
}

export const useFriendsStore = defineStore('friends', {
  state: () => ({
    contacts: [] as Contact[],
    editor: { open: false, contact: null, prefill: null } as FriendEditorState,
  }),
  getters: {
    // contactId → contact, rebuilt only when the contact list changes. Lets the
    // per-row presence getter be O(1) instead of re-scanning on every render.
    contactById(state): Map<number, Contact> {
      const m = new Map<number, Contact>();
      for (const c of state.contacts) m.set(c.id, c);
      return m;
    },
    // `${networkId}::${nickLower}` → contact, for the menu Add/Edit label and the
    // came-online toast gate without scanning every contact on each presence
    // event. (network, nick) maps to at most one contact by the server's
    // uniqueness rule, so a flat map is exact.
    contactByTarget(state): Map<string, Contact> {
      const m = new Map<string, Contact>();
      for (const c of state.contacts)
        for (const t of c.targets) m.set(`${t.networkId}::${t.nick.toLowerCase()}`, c);
      return m;
    },
    // Presence of the PRIMARY target — the DM that opens when the friend is
    // clicked. This is what the sidebar row + overview header show, so the dot
    // never claims "online" when the DM you'd open is actually offline (a friend
    // online under a different nick/network shows in the per-network breakdown,
    // not here). Disconnected-aware via networks.peerFor: a down network reads
    // offline.
    primaryPresence(): (contactId: number) => FriendPresence {
      const byId = this.contactById;
      const networks = useNetworksStore();
      return (contactId) => {
        const c = byId.get(contactId);
        const t = c ? primaryTargetOf(c) : null;
        if (!t) return 'unknown';
        return deriveState(networks.peerFor(t.networkId, t.nick));
      };
    },
    // Presence for a single (network, nick) target — the per-network breakdown
    // in the Friends overview.
    presenceForTarget(): (networkId: number, nick: string) => FriendPresence {
      const networks = useNetworksStore();
      return (networkId, nick) => deriveState(networks.peerFor(networkId, nick));
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
        const existing = buffers.findDm(t.networkId, t.nick);
        out.push({ networkId: t.networkId, target: existing ? existing.target : t.nick });
      }
      return out;
    },
    // The contact (if any) watching (networkId, nick) — drives the nick menu's
    // Add/Edit Friend label.
    contactForTarget(): (networkId: number, nick: string) => Contact | null {
      const byTarget = this.contactByTarget;
      return (networkId, nick) =>
        byTarget.get(`${networkId}::${(nick || '').toLowerCase()}`) ?? null;
    },
    // Find a contact watching (networkId, nick) whose notify flag is on — used
    // by the came-online toast gate.
    notifyContactFor(): (networkId: number, nick: string) => Contact | null {
      const byTarget = this.contactByTarget;
      return (networkId, nick) => {
        const c = byTarget.get(`${networkId}::${(nick || '').toLowerCase()}`);
        return c && c.notifyOnline ? c : null;
      };
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
    openEditorNew() {
      this.editor = { open: true, contact: null, prefill: null };
    },
    closeEditor() {
      this.editor = { open: false, contact: null, prefill: null };
    },
    saveContact(payload: {
      contactId?: number | null;
      displayName: string;
      notifyOnline: boolean;
      targets: Array<{ networkId: number; nick: string; isPrimary: boolean }>;
    }) {
      socketSend({
        type: 'set-contact',
        contactId: payload.contactId ?? null,
        displayName: payload.displayName,
        notifyOnline: payload.notifyOnline,
        targets: payload.targets,
      });
    },
    removeContact(contactId: number) {
      socketSend({ type: 'delete-contact', contactId });
    },

    // ---- navigation ----
    // Open the FRIENDS overview pane (the virtual buffer's body).
    open() {
      useNetworksStore().activateVirtual(FRIENDS_KEY);
    },
    // Open a specific (network, nick) DM, resolving to an existing buffer's case
    // so we don't fork a second buffer that differs only by nick case.
    openDmTarget(networkId: number, nick: string) {
      const buffers = useBuffersStore();
      const existing = buffers.findDm(networkId, nick);
      buffers.activate(networkId, existing ? existing.target : nick);
    },
    // Open the friend's primary DM. A target-less contact falls back to its editor.
    openDm(contact: Contact) {
      const t = primaryTargetOf(contact);
      if (!t) {
        this.openEditorForContact(contact);
        return;
      }
      this.openDmTarget(t.networkId, t.nick);
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
