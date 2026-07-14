// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Deployment config the client reads once at boot from the public /api/config
// endpoint. It carries the edition (self-hosted standalone vs a hosted
// lurker.chat cell), which the Settings UI uses to gate operator-only surfaces
// (A3). It defaults to the safe value so a fetch failure degrades to the
// fully-featured self-hosted experience rather than hiding things.

import { defineStore } from 'pinia';
import { api } from '../api.js';

export type Edition = 'standalone' | 'node';

// Shared in-flight fetch so concurrent callers — App.vue's boot fetch and the
// router guard on a cold /admin deep-link — coalesce onto one request instead
// of each firing their own GET /api/config. Module-scoped (not store state) so
// it stays non-reactive.
let inflight: Promise<Edition> | null = null;

export const useConfigStore = defineStore('config', {
  state: () => ({
    edition: 'standalone' as Edition,
    checked: false,
  }),
  getters: {
    // True when this client is talking to a hosted cell, not a self-hosted box.
    isNode: (s): boolean => s.edition === 'node',
  },
  actions: {
    async fetch(): Promise<Edition> {
      if (this.checked) return this.edition; // already resolved — never refetch
      if (inflight) return inflight; // a fetch is in flight — share its result
      inflight = (async () => {
        try {
          const data = await api<{ edition?: string }>('/api/config');
          this.edition = data.edition === 'node' ? 'node' : 'standalone';
          // Latch `checked` ONLY on success. A transient failure must not wedge
          // the session on the safe defaults — leaving it false lets the next
          // caller retry and self-heal. That second caller is the router guard,
          // which re-attempts on every navigation while `checked` is false;
          // App.vue's boot fetch fires only once, so on its own it would be a
          // single point of failure.
          this.checked = true;
        } catch (_err) {
          this.edition = 'standalone';
        } finally {
          inflight = null;
        }
        return this.edition;
      })();
      return inflight;
    },
  },
});
