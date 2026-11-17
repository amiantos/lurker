// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { useNetworksStore } from './networks.js';
import { parseSearchQuery } from '../utils/searchQuery.js';

const PAGE_SIZE = 50;

// The rows are full decorated events; only the fields the UI reads are typed.
export interface SearchResult {
  id: number;
  networkId: number;
  target: string;
  nick: string;
  text?: string;
  time?: string;
  networkName?: string;
  // Sender hostmask, when known — drives client-side ignore filtering.
  userhost?: string | null;
}

// A fresh search aborts the in-flight one — over REST a superseded
// search-as-you-type request is actually cancelled (the server checks
// req.destroyed before spending the query), where the old WS verb ran every
// stale search to completion and merely discarded the reply. Module-level
// because an AbortController doesn't belong in reactive store state.
let inflight: AbortController | null = null;

// Full-text message search over GET /api/search (#676) — the search_messages
// verb behind the same `{items, nextBefore}` feed contract as highlights and
// bookmarks. This store is the reference implementation for clients that
// used the removed WS `search` command (docs/MIGRATION_2_7.md). It is a thin view of the
// most recent query's results plus its pagination cursor.
export const useSearchStore = defineStore('search', {
  state: () => ({
    query: '', // Raw input string, including the from:/in:/on: syntax.
    results: [] as SearchResult[],
    nextBefore: null as number | null, // Message id cursor for the next page.
    loading: false,
    error: '',
    // Monotonic token tagged onto each fresh search; a response that resolves
    // after its token has been superseded is dropped (debounced typing fires
    // several searches). Pagination reuses the current token — it continues a
    // search rather than starting a new one.
    token: 0,
    // True once a search has actually been dispatched, so the modal can tell
    // "no matches" apart from "haven't searched yet".
    searched: false,
    // URL of the last dispatched fresh search. The modal's typing debounce
    // fires on ANY input change, including ones that parse to the same query
    // (a trailing space, an incomplete `from:` token still in free text) —
    // without this, each of those cleared the results and refetched identical
    // rows. History is immutable, so serving the standing results for an
    // identical effective query is always correct.
    lastUrl: null as string | null,
    // Persist the modal's scroll position and keyboard cursor across
    // open/close. Tapping a result jumps to a buffer and closes the modal;
    // reopening should put the user back exactly where they were so a series
    // of "search → reference → close → reopen → next result" reads feels
    // continuous. Reset by runSearch() — a brand-new query starts fresh.
    scrollTop: 0,
  }),
  getters: {
    hasMore: (state) => state.nextBefore != null,
  },
  actions: {
    setQuery(raw: string) {
      this.query = raw;
    },
    // Build the request URL from the raw query. Returns null when there's
    // nothing to search on (no free text and no structured filter).
    buildUrl(before: number | null): string | null {
      const parsed = parseSearchQuery(this.query);
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      if (parsed.query) params.set('q', parsed.query);
      // `from:` may repeat (a friend's alts) — append each so the server
      // OR-matches every nick.
      for (const nick of parsed.from) params.append('nick', nick);
      if (parsed.in) params.set('target', parsed.in);
      let networkId: number | null = null;
      if (parsed.on) {
        const networks = useNetworksStore();
        const match = networks.networks.find(
          (n) => n.name.toLowerCase() === parsed.on.toLowerCase(),
        );
        if (match) networkId = match.id;
      }
      if (networkId != null) params.set('networkId', String(networkId));
      if (!parsed.query && !parsed.from.length && !parsed.in && networkId == null) {
        return null;
      }
      if (before) params.set('before', String(before));
      return `/api/search?${params.toString()}`;
    },
    async runSearch() {
      const url = this.buildUrl(null);
      // Same effective query as the search already on screen — keep it. The
      // `searched` guard covers the scoped modal's fresh slate (it patches
      // searched:false), and an errored dispatch clears itself below so a
      // retype retries instead of being swallowed.
      if (url !== null && this.searched && !this.error && url === this.lastUrl) return;
      this.lastUrl = url;
      const token = (this.token += 1);
      inflight?.abort();
      this.results = [];
      this.nextBefore = null;
      this.error = '';
      this.scrollTop = 0;
      if (!url) {
        this.loading = false;
        this.searched = false;
        return;
      }
      const controller = new AbortController();
      inflight = controller;
      this.loading = true;
      this.searched = true;
      try {
        const { items, nextBefore } = await api(url, { signal: controller.signal });
        if (token !== this.token) return; // Superseded by a newer search.
        this.results = items || [];
        this.nextBefore = nextBefore ?? null;
      } catch (e: any) {
        if (token !== this.token || controller.signal.aborted) return;
        this.error = e.message || 'search failed';
      } finally {
        if (token === this.token) this.loading = false;
      }
    },
    async loadMore() {
      if (this.loading || this.nextBefore == null) return;
      const url = this.buildUrl(this.nextBefore);
      if (!url) return;
      const token = this.token;
      this.loading = true;
      // Clear any stale failure so a successful retry doesn't render fresh
      // rows under an old error banner (same pattern as the highlights store).
      this.error = '';
      try {
        const { items, nextBefore } = await api(url);
        if (token !== this.token) return; // Query changed while paging.
        // Append — dedupe by id in case pages overlap.
        const seen = new Set(this.results.map((r) => r.id));
        for (const r of (items || []) as SearchResult[]) {
          if (!seen.has(r.id)) this.results.push(r);
        }
        this.nextBefore = nextBefore ?? null;
      } catch (e: any) {
        if (token !== this.token) return;
        this.error = e.message || 'search failed';
      } finally {
        if (token === this.token) this.loading = false;
      }
    },
    reset() {
      inflight?.abort();
      this.query = '';
      this.results = [];
      this.nextBefore = null;
      this.loading = false;
      this.error = '';
      this.searched = false;
      this.lastUrl = null;
      this.scrollTop = 0;
    },
  },
});
