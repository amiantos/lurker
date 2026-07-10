// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { useAuthStore } from './auth.js';
import { isVirtualKey } from '../lib/virtualBuffers.js';
import type { MultilineLimits } from '../utils/messageSplit.js';

export interface Network {
  id: number;
  name: string;
  host: string;
  port: number;
  nick: string;
  tls: boolean;
  [key: string]: unknown;
}

export interface PeerPresenceEntry {
  nick: string;
  state: string | null;
  stateAt: string | null;
  awayMessage: string | null;
}

// User-level self-presence, broadcast per network from the away-state stream.
// Mirrors the in-memory shape ircManager/IrcConnection hold (`AwayState`
// there); `message` and `since` stay populated after /back so the buffer
// dividers can render the completed away→back pair.
export interface AwayState {
  active: boolean;
  message: string | null;
  since: string | null;
  autoSet: boolean;
  backAt: string | null;
}

export interface NetworkState {
  networkId: number;
  channels: string[];
  state?: string;
  nick?: string;
  userModes?: string;
  away?: AwayState | null;
  peerPresence?: Record<string, PeerPresenceEntry>;
  lagMs?: number | null;
  // Advertised draft/multiline limits when the network negotiated the cap,
  // else null/absent. Drives the composer's multiline-aware SPLIT/FLOOD hint
  // and upload-as-.txt gate. Refreshed by the snapshot pushed on connect. (#381)
  multilineLimits?: MultilineLimits | null;
}

export interface ActiveBuffer {
  networkId: number;
  target: string;
  network: Network | undefined;
}

export const useNetworksStore = defineStore('networks', {
  state: () => ({
    networks: [] as Network[],
    states: {} as Record<number | string, NetworkState>,
    activeKey: null as string | null,
  }),
  getters: {
    networkById: (state) => (id: number) => state.networks.find((n) => n.id === id) || null,
    // Presence row for a (network, nick), disconnected-aware: a down network's
    // cached rows are stale, so report a synthetic 'offline'. Connected with no
    // row stays null (unknown = "potentially online", the no-MONITOR case).
    // Single source of truth for the sidebar, status bar, profile, and Friends.
    peerFor:
      (state) =>
      (networkId: number | string, nick: string): PeerPresenceEntry | null => {
        const netState = state.states[networkId];
        if (netState && netState.state !== 'connected')
          return { nick, state: 'offline', stateAt: null, awayMessage: null };
        return netState?.peerPresence?.[nick.toLowerCase()] ?? null;
      },
    // Parse any buffer key into its (network, target) pair. Split out from
    // activeBuffer so a view rendering a buffer OTHER than the active one (a
    // windowed BufferPane) can resolve its own key through the same rules
    // rather than re-implementing the `${networkId}::${target}` split.
    bufferFor(state) {
      return (key: string | null): ActiveBuffer | null => {
        if (!key) return null;
        // Virtual buffers (:system:, :friends:) use a flat sentinel key (no
        // `::`). They have no IRC send target, so report "no IRC buffer" — the
        // views drive their own header/rendering. Friends still renders
        // messages via buffers.byKey(key) directly, not through this getter.
        if (isVirtualKey(key)) return null;
        if (!key.includes('::')) return null;
        const [networkId, name] = key.split('::');
        const id = Number(networkId);
        return { networkId: id, target: name, network: state.networks.find((n) => n.id === id) };
      };
    },
    activeBuffer(): ActiveBuffer | null {
      return this.bufferFor(this.activeKey);
    },
  },
  actions: {
    async fetchAll() {
      const { networks } = await api('/api/networks');
      this.networks = networks;
    },
    async create(payload: Partial<Network>) {
      const { network } = await api('/api/networks', { method: 'POST', body: payload });
      this.networks.push(network);
      return network as Network;
    },
    async update(id: number, patch: Partial<Network>) {
      const { network } = await api(`/api/networks/${id}`, { method: 'PATCH', body: patch });
      const idx = this.networks.findIndex((n) => n.id === id);
      if (idx >= 0) this.networks[idx] = network;
      return network as Network;
    },
    // Rewrite sidebar order. Server validates the id set; on 409 it echoes the
    // authoritative list, which we apply so the UI snaps back to truth instead
    // of staying out of sync after a concurrent add/delete from another tab.
    async reorder(ids: number[]) {
      try {
        const { networks } = await api('/api/networks/reorder', {
          method: 'POST',
          body: { ids },
        });
        this.networks = networks;
      } catch (err: any) {
        if (err?.status === 409 && Array.isArray(err.data?.networks)) {
          this.networks = err.data.networks;
        }
        throw err;
      }
    },
    async remove(id: number) {
      await api(`/api/networks/${id}`, { method: 'DELETE' });
      this.networks = this.networks.filter((n) => n.id !== id);
      delete this.states[id];
      if (this.activeKey?.startsWith(`${id}::`)) this.activeKey = null;
    },
    // The IRC connection toggles are the writes most reachable from the
    // read-only browse view (header toggle, network context menu), so they get
    // a client-side short-circuit to avoid firing a request the server would
    // 403 anyway. Config mutations (create/update/remove) are reached only from
    // editing UI a paused user shouldn't be in, and stay server-enforced.
    async connect(id: number) {
      if (useAuthStore().isPaused) return;
      await api(`/api/networks/${id}/connect`, { method: 'POST' });
    },
    async disconnect(id: number, reason?: string) {
      if (useAuthStore().isPaused) return;
      await api(`/api/networks/${id}/disconnect`, {
        method: 'POST',
        ...(reason ? { body: { reason } } : {}),
      });
    },
    async reconnect(id: number) {
      if (useAuthStore().isPaused) return;
      await api(`/api/networks/${id}/reconnect`, { method: 'POST' });
    },
    setActive(networkId: number | string | null, target: string) {
      // The app-scoped system buffer (#355) has no network — it keys on the bare
      // sentinel target, matching the buffers store's key() helper.
      this.activeKey = networkId == null ? target : `${networkId}::${target}`;
    },
    // Virtual buffers (system console, friends) aren't tied to an IRC network.
    // They use a flat sentinel key (no `::`) so the existing
    // `${networkId}::${target}` parsers ignore them.
    activateVirtual(key: string) {
      this.activeKey = key;
    },
    applySnapshot(networks: NetworkState[]) {
      const map: Record<number | string, NetworkState> = {};
      for (const snap of networks) map[snap.networkId] = snap;
      this.states = map;
    },
    applyState(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        state: event.state,
        nick: event.nick || existing.nick,
      };
    },
    applyOwnNick(event: any) {
      const existing = this.states[event.networkId];
      if (!existing || !event.nick) return;
      this.states[event.networkId] = { ...existing, nick: event.nick };
    },
    applyUserMode(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        userModes: typeof event.modes === 'string' ? event.modes : '',
      };
    },
    applyAwayState(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      this.states[event.networkId] = {
        ...existing,
        away: event.away || null,
      };
    },
    // Per-(network, nick) peer presence. Single most-recent-event shape:
    // { state, stateAt } where state ∈ {online, offline, away, back}.
    // Stored under the network state bucket so the snapshot apply seeds it
    // instantly; readers (MessageList marker, BufferList decoration,
    // StatusBar segment) look up by lowercase nick.
    applyPeerPresence(networkId: number | string, nick: string, payload: any) {
      if (!networkId || !nick) return;
      const existing = this.states[networkId] || { networkId: Number(networkId), channels: [] };
      const peerPresence = { ...existing.peerPresence };
      peerPresence[nick.toLowerCase()] = {
        nick,
        state: payload?.state || null,
        stateAt: payload?.stateAt || null,
        awayMessage: payload?.awayMessage || null,
      };
      this.states[networkId] = { ...existing, peerPresence };
    },
    applyLag(event: any) {
      const existing = this.states[event.networkId] || { networkId: event.networkId, channels: [] };
      const v = event.lagMs;
      this.states[event.networkId] = {
        ...existing,
        lagMs: typeof v === 'number' ? v : null,
      };
    },
  },
});
