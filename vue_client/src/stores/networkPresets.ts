// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The admin-defined networks this instance recommends, plus whether users may
// connect to anything else (#298). Fetched once per session; the picker merges
// these with the bundled builtins.

import { defineStore } from 'pinia';
import { api } from '../api.js';
import type { NetworkPreset } from '../utils/builtinNetworks.js';

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export const useNetworkPresetsStore = defineStore('networkPresets', {
  state: () => ({
    presets: [] as NetworkPreset[],
    // Permissive until we hear otherwise, matching how UploadsPane treats
    // allowUserDefined: an un-fetched or older server must not accidentally
    // present itself as a locked-down instance and hide the whole picker.
    allowUserDefined: true,
    loaded: false,
    loading: null as Promise<void> | null,
  }),
  actions: {
    async fetchAll() {
      if (this.loading) return this.loading;
      this.loading = (async () => {
        const data = await api('/api/network-presets');
        this.presets = (data.presets ?? []).map((p: Record<string, unknown>): NetworkPreset => ({
          instanceId: Number(p.id),
          name: String(p.name),
          host: String(p.host),
          port: Number(p.port),
          tls: !!p.tls,
          saslLikelyRequired: !!p.saslLikelyRequired,
          recommendedChannels: Array.isArray(p.channels) ? (p.channels as string[]) : [],
          // Tags and counts are the admin's to give, and a card shows only
          // what it was given. An older server sends none. Neither moves the
          // row: instance presets stay pinned, in the admin's order.
          website: '',
          users: count(p.users),
          channels: count(p.channelCount),
          tags: Array.isArray(p.tags)
            ? p.tags.filter((t): t is string => typeof t === 'string')
            : [],
          isInstance: true,
        }));
        this.allowUserDefined = data.allowUserDefined !== false;
        this.loaded = true;
      })();
      try {
        await this.loading;
      } finally {
        this.loading = null;
      }
    },
  },
});
