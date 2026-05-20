// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { socketSend } from '../composables/useSocket.js';

// Two-track state: a lightweight `Set<messageId>` always in memory, seeded by
// the `bookmark-ids-snapshot` envelope at connect and mutated by echoes — used
// by the message context menu to flip "Save" ↔ "Remove bookmark" without a
// network call. The heavyweight paginated `items` list is lazy-loaded by the
// BookmarksModal via REST. Adds invalidate `items` so the next modal open
// refetches, since we don't have the full row payload from the echo alone.
const PAGE_SIZE = 50;

export interface BookmarkMessage {
  id: number;
  networkId: number;
  target: string;
  nick: string;
  body: string;
  createdAt: string;
  // Sender hostmask, when known — drives client-side ignore filtering.
  userhost?: string | null;
}

export const useBookmarksStore = defineStore('bookmarks', {
  state: () => ({
    ids: new Set<number>(),
    items: [] as BookmarkMessage[],
    nextBefore: null as number | null,
    loading: false,
    error: '',
    listDirty: true,
  }),
  getters: {
    hasMore: (state) => state.nextBefore != null,
    isSaved: (state) => (messageId: number | string) => state.ids.has(Number(messageId)),
    count: (state) => state.ids.size,
  },
  actions: {
    applySnapshot(ids: (number | string)[]) {
      const next = new Set<number>();
      for (const id of ids || []) {
        const n = Number(id);
        if (Number.isFinite(n)) next.add(n);
      }
      this.ids = next;
      this.listDirty = true;
    },
    applyUpdate({ messageId, saved }: { messageId: number | string; saved: boolean }) {
      const id = Number(messageId);
      if (!Number.isFinite(id)) return;
      if (saved) {
        if (!this.ids.has(id)) {
          this.ids.add(id);
          this.listDirty = true;
        }
      } else {
        if (this.ids.delete(id)) {
          // Splice out of the loaded page so the modal updates immediately.
          const idx = this.items.findIndex((m) => m.id === id);
          if (idx >= 0) this.items.splice(idx, 1);
        }
      }
    },
    toggle(message: { id?: number | string | null }) {
      if (!message || message.id == null) return;
      const id = Number(message.id);
      if (!Number.isFinite(id)) return;
      if (this.ids.has(id)) {
        socketSend({ type: 'unset-bookmark', messageId: id });
      } else {
        socketSend({ type: 'set-bookmark', messageId: id });
      }
    },
    remove(messageId: number | string) {
      const id = Number(messageId);
      if (!Number.isFinite(id)) return;
      socketSend({ type: 'unset-bookmark', messageId: id });
    },
    async loadInitial() {
      this.loading = true;
      this.error = '';
      try {
        const { items, nextBefore } = await api(`/api/bookmarks?limit=${PAGE_SIZE}`);
        this.items = items || [];
        this.nextBefore = nextBefore ?? null;
        this.listDirty = false;
      } catch (e: any) {
        this.error = e.message || 'failed to load bookmarks';
      } finally {
        this.loading = false;
      }
    },
    async loadMore() {
      if (this.loading || this.nextBefore == null) return;
      this.loading = true;
      this.error = '';
      try {
        const { items, nextBefore } = await api(
          `/api/bookmarks?limit=${PAGE_SIZE}&before=${this.nextBefore}`,
        );
        this.items = this.items.concat(items || []);
        this.nextBefore = nextBefore ?? null;
      } catch (e: any) {
        this.error = e.message || 'failed to load more bookmarks';
      } finally {
        this.loading = false;
      }
    },
    async ensureLoaded() {
      if (this.listDirty || this.items.length === 0) {
        await this.loadInitial();
      }
    },
  },
});
