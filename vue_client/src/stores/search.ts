// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSend } from '../composables/useSocket.js';
import { useNetworksStore } from './networks.js';
import { parseSearchQuery } from '../utils/searchQuery.js';

const PAGE_SIZE = 50;

export interface SearchResult {
  id: number;
  networkId: number;
  target: string;
  nick: string;
  body: string;
  createdAt: string;
  // Sender hostmask, when known — drives client-side ignore filtering.
  userhost?: string | null;
}

// Full-text message search. WS-based (like chanlist) rather than REST — the
// server owns the FTS index and there's no separate HTTP route. The store is a
// thin view of the most recent query's results plus its pagination cursor.
export const useSearchStore = defineStore('search', {
  state: () => ({
    query: '', // Raw input string, including the from:/in:/on: syntax.
    results: [] as SearchResult[],
    hasMore: false,
    nextBefore: null as number | null, // Message id cursor for the next page.
    loading: false,
    error: '',
    // Monotonic token tagged onto each fresh search; the server echoes it and
    // results for a superseded token are dropped (debounced typing fires
    // several searches). Pagination reuses the current token — it continues a
    // search rather than starting a new one.
    token: 0,
    // True once a search has actually been dispatched, so the modal can tell
    // "no matches" apart from "haven't searched yet".
    searched: false,
    // Persist the modal's scroll position and keyboard cursor across
    // open/close. Tapping a result jumps to a buffer and closes the modal;
    // reopening should put the user back exactly where they were so a series
    // of "search → reference → close → reopen → next result" reads feels
    // continuous. Reset by runSearch() — a brand-new query starts fresh.
    scrollTop: 0,
    selectedIndex: 0,
  }),
  actions: {
    setQuery(raw: string) {
      this.query = raw;
    },
    // Build the structured WS payload from the raw query. Returns null when
    // there's nothing to search on (no free text and no structured filter).
    _buildPayload(before: number | null) {
      const parsed = parseSearchQuery(this.query);
      const payload: Record<string, unknown> = {
        type: 'search',
        token: this.token,
        limit: PAGE_SIZE,
      };
      if (parsed.query) payload.query = parsed.query;
      if (parsed.from) payload.nick = parsed.from;
      if (parsed.in) payload.target = parsed.in;
      if (parsed.on) {
        const networks = useNetworksStore();
        const match = networks.networks.find(
          (n) => n.name.toLowerCase() === parsed.on.toLowerCase(),
        );
        if (match) payload.networkId = match.id;
      }
      if (!payload.query && !payload.nick && !payload.target && payload.networkId == null) {
        return null;
      }
      if (before) payload.before = before;
      return payload;
    },
    runSearch() {
      this.token += 1;
      this.results = [];
      this.hasMore = false;
      this.nextBefore = null;
      this.error = '';
      this.scrollTop = 0;
      this.selectedIndex = 0;
      const payload = this._buildPayload(null);
      if (!payload) {
        this.loading = false;
        this.searched = false;
        return;
      }
      this.loading = true;
      this.searched = true;
      if (!socketSend(payload)) {
        this.loading = false;
        this.error = 'not connected';
      }
    },
    loadMore() {
      if (this.loading || !this.hasMore || this.nextBefore == null) return;
      const payload = this._buildPayload(this.nextBefore);
      if (!payload) return;
      this.loading = true;
      if (!socketSend(payload)) {
        this.loading = false;
        this.error = 'not connected';
      }
    },
    applyResult(payload: any) {
      if (payload.token !== this.token) return; // Superseded query.
      this.loading = false;
      const incoming: SearchResult[] = Array.isArray(payload.results) ? payload.results : [];
      if (payload.before) {
        // Pagination append — dedupe by id in case batches overlap.
        const seen = new Set(this.results.map((r) => r.id));
        for (const r of incoming) {
          if (!seen.has(r.id)) this.results.push(r);
        }
      } else {
        this.results = incoming;
      }
      this.hasMore = !!payload.hasMore;
      const last = this.results[this.results.length - 1];
      this.nextBefore = this.hasMore && last ? last.id : null;
    },
    reset() {
      this.query = '';
      this.results = [];
      this.hasMore = false;
      this.nextBefore = null;
      this.loading = false;
      this.error = '';
      this.searched = false;
      this.scrollTop = 0;
      this.selectedIndex = 0;
    },
  },
});
