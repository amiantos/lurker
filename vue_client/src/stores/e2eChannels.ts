// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { useBuffersStore } from './buffers.js';

// Which channels have end-to-end encryption on (#422), so the topic bar can
// mark them. The server is the source of truth: the snapshot carries each
// network's list as `e2eChannels`, and an `e2e-channels-changed` frame replaces
// one network's list whole after `/e2e on|off|mode` or a keyring import.
//
// Not a bufferLifecycle participant: nothing here is keyed by a buffer. A name
// is the server's spelling of an E2E context, which outlives a closed buffer
// (the channel is still enabled) and is matched to a buffer at read time.
export const useE2eChannelsStore = defineStore('e2eChannels', {
  state: () => ({
    // { [networkId]: channel names as the server's config spells them }
    byNetwork: {} as Record<number | string, string[]>,
  }),
  getters: {
    isEnabled:
      (state) =>
      (networkId: number | string | null, target: string): boolean => {
        if (networkId == null) return false;
        const names = state.byNetwork[networkId];
        if (!names?.length) return false;
        if (names.includes(target)) return true;
        // The config's spelling can differ from the buffer's in case; the
        // buffers store folds by the network's own casemapping.
        const buffers = useBuffersStore();
        return names.some((name) => buffers.findByTarget(networkId, name)?.target === target);
      },
  },
  actions: {
    applySnapshot(networks: any[]) {
      const next: Record<number | string, string[]> = {};
      for (const n of networks || []) {
        if (n?.networkId != null) next[n.networkId] = stringList(n.e2eChannels);
      }
      this.byNetwork = next;
    },
    applyChange(networkId: number | string, channels: unknown) {
      this.byNetwork[networkId] = stringList(channels);
    },
  },
});

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
