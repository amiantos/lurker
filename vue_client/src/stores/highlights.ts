// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { useNetworksStore } from './networks.js';
import { parseSearchQuery } from '../utils/searchQuery.js';

const PAGE_SIZE = 50;

export interface HighlightItem {
  id: number;
  networkId: number;
  target: string;
  nick: string;
  body: string;
  createdAt: string;
  // Sender hostmask, when known — drives client-side ignore filtering.
  userhost?: string | null;
}

// Highlights feed. REST-based (the highlights route owns the FTS query). The
// optional from:/in:/on: + free-text filter reuses the same parser as search;
// `on:` resolves a network name to its id client-side, mirroring the search
// store, since the API takes a numeric networkId.
export const useHighlightsStore = defineStore('highlights', {
  state: () => ({
    query: '', // Raw filter input, including the from:/in:/on: syntax.
    items: [] as HighlightItem[],
    nextBefore: null as number | null,
    loading: false,
    error: '',
    // Monotonic token tagged onto each fresh load; a response whose token has
    // been superseded (the filter changed mid-flight) is dropped. Pagination
    // reuses the current token so it continues the active filter.
    token: 0,
  }),
  getters: {
    hasMore: (state) => state.nextBefore != null,
  },
  actions: {
    setQuery(raw: string) {
      this.query = raw;
    },
    // Build the request URL from the raw filter. `before` continues the current
    // page; null starts fresh.
    buildUrl(before: number | null): string {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      const parsed = parseSearchQuery(this.query);
      if (parsed.query) params.set('q', parsed.query);
      // `from:` may repeat (a friend's alts) — append each so the feed OR-matches
      // every nick, matching the search modal rather than dropping all but one.
      for (const nick of parsed.from) params.append('nick', nick);
      if (parsed.in) params.set('target', parsed.in);
      if (parsed.on) {
        const networks = useNetworksStore();
        const match = networks.networks.find(
          (n) => n.name.toLowerCase() === parsed.on.toLowerCase(),
        );
        if (match) params.set('networkId', String(match.id));
      }
      if (before) params.set('before', String(before));
      return `/api/highlights?${params.toString()}`;
    },
    // Fresh load for the current filter — resets the list and pagination.
    async loadInitial() {
      const token = (this.token += 1);
      this.items = [];
      this.nextBefore = null;
      this.error = '';
      this.loading = true;
      try {
        const { items, nextBefore } = await api(this.buildUrl(null));
        if (token !== this.token) return; // Superseded by a newer filter.
        this.items = items || [];
        this.nextBefore = nextBefore ?? null;
      } catch (e: any) {
        if (token !== this.token) return;
        this.error = e.message || 'failed to load highlights';
      } finally {
        if (token === this.token) this.loading = false;
      }
    },
    async loadMore() {
      if (this.loading || this.nextBefore == null) return;
      const token = this.token;
      this.loading = true;
      this.error = '';
      try {
        const { items, nextBefore } = await api(this.buildUrl(this.nextBefore));
        if (token !== this.token) return; // Filter changed while paging.
        this.items = this.items.concat(items || []);
        this.nextBefore = nextBefore ?? null;
      } catch (e: any) {
        if (token !== this.token) return;
        this.error = e.message || 'failed to load more highlights';
      } finally {
        if (token === this.token) this.loading = false;
      }
    },
  },
});
