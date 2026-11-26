// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import { dccChatPeer } from '../../../shared/channels.js';
import type { NickMetadataKey, NickMetadataValues } from '../../../shared/nickMetadata.js';

// Metadata the user set on other people (#1449): a display name, a colour, a
// time zone, or "don't show me theirs". The server is the source of truth, as
// for nick notes: a save goes over the WS and comes back to every session as
// `nick-metadata-updated`, so nothing here changes until the server says so.
// The networks store lays these over the wire record in `metadataFor`.
// ⚠ A `=bob` DCC chat is a conversation with bob (see nickNotes.ts).
function key(networkId: number | string, nick: string) {
  return `${networkId}::${dccChatPeer(nick || '').toLowerCase()}`;
}

export const useNickMetadataStore = defineStore('nickMetadata', {
  state: () => ({
    // { [networkId::nicklower]: { key: value | null } }; no entry = nothing set.
    byKey: {} as Record<string, NickMetadataValues>,
  }),
  getters: {
    valuesFor:
      (state) =>
      (networkId: number | string | null | undefined, nick: string): NickMetadataValues | null => {
        if (networkId == null || !nick) return null;
        return state.byKey[key(networkId, nick)] ?? null;
      },
  },
  actions: {
    applySnapshot(networks: any[]) {
      const next: Record<string, NickMetadataValues> = {};
      for (const n of networks || []) {
        if (n?.networkId == null) continue;
        for (const entry of n.nickMetadata || []) {
          if (!entry?.nick || !entry.values) continue;
          next[key(n.networkId, entry.nick)] = entry.values;
        }
      }
      this.byKey = next;
    },
    // The nick's whole record, as the server holds it now.
    applyUpdate(networkId: number | string, nick: string, values: NickMetadataValues | null) {
      if (!networkId || !nick) return;
      const k = key(networkId, nick);
      if (values && Object.keys(values).length) this.byKey[k] = values;
      else delete this.byKey[k];
    },
    // A value, or null to hide theirs (a display name or an avatar).
    set(networkId: number | string, nick: string, metaKey: NickMetadataKey, value: string | null) {
      if (!networkId || !nick) return;
      socketSend({
        type: 'set-nick-metadata',
        networkId,
        nick: dccChatPeer(nick),
        key: metaKey,
        value,
      });
    },
    // Back to whatever they set.
    reset(networkId: number | string, nick: string, metaKey: NickMetadataKey) {
      if (!networkId || !nick) return;
      socketSend({
        type: 'set-nick-metadata',
        networkId,
        nick: dccChatPeer(nick),
        key: metaKey,
        reset: true,
      });
    },
  },
});
