// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { useNetworksStore } from './networks.js';
import { parseSearchQuery } from '../utils/searchQuery.js';

const PAGE_SIZE = 50;

// A row of the activity feed (`GET /api/activity`, services/activityFeed.ts):
// a highlight, or someone's reaction to one of the user's lines. `id` is always
// the LINE (the jump target); `time` is when the item happened — the line for a
// highlight, the reaction for a reaction.
// A type alias, not an interface, so it's assignable to HistoryMessage's
// index-signatured row shape without one of its own.
export type ActivityItem = {
  kind: 'highlight' | 'reaction';
  id: number;
  networkId: number;
  target: string;
  // The sender of a highlight; whoever reacted, for a reaction.
  nick: string;
  text?: string;
  time?: string;
  networkName?: string;
  // Sender hostmask, when known — drives client-side ignore filtering.
  userhost?: string | null;
  // Reactions only.
  reactionId?: number;
  value?: string;
};

// The server's per-source cursor pair — opaque here, handed straight back.
interface ActivityCursor {
  beforeMessage?: number;
  beforeReaction?: number;
}

// The activity modal's feed (the store keeps its original name; the modal it
// feeds was "highlights" before reactions joined it). REST-based: the server
// merges highlights and reactions (services/activityFeed.ts). The optional
// from:/in:/on: + free-text filter reuses the same parser as search; `on:`
// resolves a network name to its id client-side, mirroring the search store,
// since the API takes a numeric networkId.
export const useHighlightsStore = defineStore('highlights', {
  state: () => ({
    query: '', // Raw filter input, including the from:/in:/on: syntax.
    items: [] as ActivityItem[],
    // Where the next page starts; null once there's nothing older.
    next: null as ActivityCursor | null,
    loading: false,
    error: '',
    // Monotonic token tagged onto each fresh load; a response whose token has
    // been superseded (the filter changed mid-flight) is dropped. Pagination
    // reuses the current token so it continues the active filter.
    token: 0,
    // URL of the last dispatched fresh load, for the debounced-typing path's
    // dedupe (see loadInitial). null until the first load.
    lastUrl: null as string | null,
  }),
  getters: {
    hasMore: (state) => state.next != null,
  },
  actions: {
    setQuery(raw: string) {
      this.query = raw;
    },
    // Build the request URL from the raw filter. `cursor` continues the current
    // page; null starts fresh.
    buildUrl(cursor: ActivityCursor | null): string {
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
      if (cursor?.beforeMessage) params.set('beforeMessage', String(cursor.beforeMessage));
      if (cursor?.beforeReaction) params.set('beforeReaction', String(cursor.beforeReaction));
      return `/api/activity?${params.toString()}`;
    },
    // Fresh load for the current filter — resets the list and pagination.
    //
    // `skipIfSameFilter` is for the modal's debounced-typing path, which fires
    // on ANY input change including ones that parse to the same filter (a
    // trailing space, an incomplete `from:` token) — those would blank the
    // list and refetch identical rows. Mount-time loads must NOT pass it:
    // activity is a live feed, so the same filter can have new rows since
    // the modal was last open. An errored dispatch is never skipped, so a
    // retype retries.
    async loadInitial(skipIfSameFilter = false) {
      const url = this.buildUrl(null);
      if (skipIfSameFilter && !this.error && url === this.lastUrl) return;
      this.lastUrl = url;
      const token = (this.token += 1);
      this.items = [];
      this.next = null;
      this.error = '';
      this.loading = true;
      try {
        const { items, next } = await api(url);
        if (token !== this.token) return; // Superseded by a newer filter.
        this.items = items || [];
        this.next = next ?? null;
      } catch (e: any) {
        if (token !== this.token) return;
        this.error = e.message || 'failed to load activity';
      } finally {
        if (token === this.token) this.loading = false;
      }
    },
    async loadMore() {
      if (this.loading || this.next == null) return;
      const token = this.token;
      this.loading = true;
      this.error = '';
      try {
        const { items, next } = await api(this.buildUrl(this.next));
        if (token !== this.token) return; // Filter changed while paging.
        this.items = this.items.concat(items || []);
        this.next = next ?? null;
      } catch (e: any) {
        if (token !== this.token) return;
        this.error = e.message || 'failed to load more activity';
      } finally {
        if (token === this.token) this.loading = false;
      }
    },
  },
});
