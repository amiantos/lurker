// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';

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
    activeBuffer(state): ActiveBuffer | null {
      if (!state.activeKey) return null;
      // The system-console sentinel is a flat key (no `::`). Treat it as
      // "no IRC buffer active" — the SystemConsole view drives its own
      // header and rendering off the system-log store directly.
      if (!state.activeKey.includes('::')) return null;
      const [networkId, name] = state.activeKey.split('::');
      const id = Number(networkId);
      return { networkId: id, target: name, network: state.networks.find((n) => n.id === id) };
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
    async connect(id: number) {
      await api(`/api/networks/${id}/connect`, { method: 'POST' });
    },
    async disconnect(id: number, reason?: string) {
      await api(`/api/networks/${id}/disconnect`, {
        method: 'POST',
        ...(reason ? { body: { reason } } : {}),
      });
    },
    async reconnect(id: number) {
      await api(`/api/networks/${id}/reconnect`, { method: 'POST' });
    },
    setActive(networkId: number | string, target: string) {
      this.activeKey = `${networkId}::${target}`;
    },
    // System console is the only "buffer" that isn't tied to an IRC network —
    // it's the per-user log of server lifecycle events surfaced via the
    // "lurker" sidebar header. Uses a flat sentinel key (no `::`) so the
    // existing `${networkId}::${target}` parsers ignore it.
    activateSystem() {
      this.activeKey = ':system:';
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
