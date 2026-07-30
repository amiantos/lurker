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

/** Instance feature flags from /api/config. Absent means off — a server that doesn't advertise
 *  a flag doesn't have the feature. */
export interface Features {
  linkPreviews: boolean;
}

// Shared in-flight fetch so concurrent callers — App.vue's boot fetch and the
// router guard on a cold /admin deep-link — coalesce onto one request instead
// of each firing their own GET /api/config. Module-scoped (not store state) so
// it stays non-reactive.
let inflight: Promise<Edition> | null = null;

export const useConfigStore = defineStore('config', {
  state: () => ({
    edition: 'standalone' as Edition,
    // ⚠ Defaults to OFF, unlike `edition`, which defaults to the fully-featured value. A fetch
    // failure must not conjure a feature the server may not have: guessing "on" here would show
    // the two settings and then have every resolve 404.
    features: { linkPreviews: false } as Features,
    checked: false,
  }),
  getters: {
    // True when this client is talking to a hosted cell, not a self-hosted box.
    isNode: (s): boolean => s.edition === 'node',
    /** Whether this instance has link previews / inline media enabled at all. */
    linkPreviews: (s): boolean => s.features.linkPreviews === true,
  },
  actions: {
    async fetch(): Promise<Edition> {
      if (this.checked) return this.edition; // already resolved — never refetch
      if (inflight) return inflight; // a fetch is in flight — share its result
      inflight = (async () => {
        try {
          const data = await api<{ edition?: string; features?: Partial<Features> }>('/api/config');
          this.edition = data.edition === 'node' ? 'node' : 'standalone';
          this.features = { linkPreviews: data.features?.linkPreviews === true };
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
