// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { socketSend } from '../composables/useSocket.js';
import { useNetworksStore } from './networks.js';
import { parseSearchQuery } from '../utils/searchQuery.js';
import type { MessageReaction } from '../../../shared/reactions.js';

// IRCv3 reactions, two tracks — the same split as bookmarks:
//
// `byMessage` is what's standing on each line we've seen, keyed by message id.
// It lives beside the message rows rather than on them because the buffers
// store swaps whole slices (jumps, reattach, history pages) and never patches a
// row in place; a side map survives all of that. Each row that arrives says
// what's on it (`reactions`, absent when none), and a `reaction` frame adds or
// removes one live. Like the bookmark Set it's a cache of what we've SEEN.
//
// `items` is the reactions tab of the highlights modal: other people's
// reactions to the user's own lines, REST-loaded and paged, with the highlights
// feed's from:/in:/on: filter.
const PAGE_SIZE = 50;

// One chip on a line's reaction row: a value, how many reacted with it, who, and
// whether we're among them.
export interface ReactionGroup {
  value: string;
  nicks: string[];
  mine: boolean;
}

// A row of the reactions tab (`GET /api/highlights/reactions`). `id` is the
// line reacted to, so the shared jump handler lands on it; `nick`/`value`/`time`
// are the reaction's.
export interface ReactionFeedItem {
  id: number;
  reactionId: number;
  networkId: number;
  networkName: string;
  target: string;
  nick: string;
  value: string;
  time: string;
  text: string | null;
  messageTime: string;
  [key: string]: unknown;
}

// The live frame (wsHub fans it out for every change handleReaction records).
export interface ReactionFrame {
  networkId: number;
  bufferId: number;
  target: string;
  messageId: number;
  nick: string;
  value: string;
  self: boolean;
  remove: boolean;
  toSelf: boolean;
  time: string;
}

const sameNick = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const useReactionsStore = defineStore('reactions', {
  state: () => ({
    byMessage: new Map<number, MessageReaction[]>(),
    query: '',
    items: [] as ReactionFeedItem[],
    nextBefore: null as number | null,
    loading: false,
    error: '',
    token: 0,
    lastUrl: null as string | null,
    // The react picker (ReactModal), opened from a line's React action or the
    // add chip on its reaction row.
    picker: {
      open: false,
      messageId: null as number | null,
      networkId: null as number | null,
      nick: '',
      text: '',
    },
  }),
  getters: {
    hasMore: (state) => state.nextBefore != null,
    // The groups for one line: reactions grouped by value, first-reacted first.
    groupsFor:
      (state) =>
      (messageId: number | string | null | undefined): ReactionGroup[] => {
        if (messageId == null) return [];
        const list = state.byMessage.get(Number(messageId));
        if (!list || list.length === 0) return [];
        const groups: ReactionGroup[] = [];
        for (const r of list) {
          let g = groups.find((x) => x.value === r.value);
          if (!g) {
            g = { value: r.value, nicks: [], mine: false };
            groups.push(g);
          }
          g.nicks.push(r.nick);
          if (r.self) g.mine = true;
        }
        return groups;
      },
  },
  actions: {
    // Reconcile against a page of message rows. Each row is authoritative for
    // itself: no `reactions` means none stand on it now (one removed while this
    // tab was away arrives exactly like that). Rows the page doesn't carry are
    // left alone. Skipped for the system buffer, whose ids are a separate
    // sequence that overlaps this one — see bookmarks.noteFromEvents.
    noteFromEvents(
      events: Array<{ id?: number | string | null; reactions?: MessageReaction[] }>,
      networkId: number | null | undefined,
    ) {
      if (!Array.isArray(events) || networkId == null) return;
      for (const e of events) {
        if (e?.id == null) continue;
        const id = Number(e.id);
        if (!Number.isFinite(id)) continue;
        if (Array.isArray(e.reactions) && e.reactions.length) this.byMessage.set(id, e.reactions);
        else this.byMessage.delete(id);
      }
    },

    applyFrame(frame: ReactionFrame) {
      const id = Number(frame.messageId);
      if (!Number.isFinite(id)) return;
      const current = this.byMessage.get(id) ?? [];
      const same = (r: MessageReaction) => r.value === frame.value && sameNick(r.nick, frame.nick);
      if (frame.remove) {
        // Ours goes by `self`, not nick — we may have reacted under an older
        // nick (see the server's removeReaction).
        const list = current.filter((r) =>
          frame.self ? !(r.self && r.value === frame.value) : !same(r),
        );
        if (list.length) this.byMessage.set(id, list);
        else this.byMessage.delete(id);
      } else if (!current.some(same)) {
        // Appended, so a group keeps its place and a new one goes last.
        this.byMessage.set(id, [
          ...current,
          { nick: frame.nick, value: frame.value, self: frame.self },
        ]);
      }

      // The tab lists other people's reactions to our lines. A new one can't be
      // spliced in — the frame doesn't carry the line's text — so it waits for
      // the next load (every modal open is one). A removal can be.
      if (frame.toSelf && !frame.self && frame.remove) {
        const idx = this.items.findIndex(
          (it) => it.id === id && it.value === frame.value && sameNick(it.nick, frame.nick),
        );
        if (idx >= 0) this.items.splice(idx, 1);
      }
    },

    // React with `value` on a line, or take ours back if it's already there.
    // Never optimistic: the server's echo is what lights the reaction up.
    toggle(messageId: number | string, value: string) {
      const id = Number(messageId);
      if (!Number.isFinite(id)) return false;
      const mine = (this.byMessage.get(id) ?? []).some((r) => r.self && r.value === value);
      return socketSend({ type: 'react', messageId: id, value, remove: mine });
    },

    openPicker(message: {
      id?: number | string | null;
      networkId?: number | null;
      nick?: string | null;
      text?: string | null;
    }) {
      if (message?.id == null || message.networkId == null) return;
      this.picker = {
        open: true,
        messageId: Number(message.id),
        networkId: message.networkId,
        nick: message.nick ?? '',
        text: message.text ?? '',
      };
    },
    closePicker() {
      this.picker = { open: false, messageId: null, networkId: null, nick: '', text: '' };
    },

    // ---- the reactions tab ----
    setQuery(raw: string) {
      this.query = raw;
    },
    buildUrl(before: number | null): string {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      const parsed = parseSearchQuery(this.query);
      if (parsed.query) params.set('q', parsed.query);
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
      return `/api/highlights/reactions?${params.toString()}`;
    },
    // Same contract as the highlights store's loadInitial — see there.
    async loadInitial(skipIfSameFilter = false) {
      const url = this.buildUrl(null);
      if (skipIfSameFilter && !this.error && url === this.lastUrl) return;
      this.lastUrl = url;
      const token = (this.token += 1);
      this.items = [];
      this.nextBefore = null;
      this.error = '';
      this.loading = true;
      try {
        const { items, nextBefore } = await api(url);
        if (token !== this.token) return;
        this.items = items || [];
        this.nextBefore = nextBefore ?? null;
      } catch (e: any) {
        if (token !== this.token) return;
        this.error = e.message || 'failed to load reactions';
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
        if (token !== this.token) return;
        this.items = this.items.concat(items || []);
        this.nextBefore = nextBefore ?? null;
      } catch (e: any) {
        if (token !== this.token) return;
        this.error = e.message || 'failed to load more reactions';
      } finally {
        if (token === this.token) this.loading = false;
      }
    },
  },
});
