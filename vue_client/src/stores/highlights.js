import { defineStore } from 'pinia';
import { api } from '../api.js';

const PAGE_SIZE = 50;

export const useHighlightsStore = defineStore('highlights', {
  state: () => ({
    items: [],
    nextBefore: null,
    loading: false,
    error: '',
  }),
  getters: {
    hasMore: (state) => state.nextBefore != null,
  },
  actions: {
    async loadInitial() {
      this.loading = true;
      this.error = '';
      try {
        const { items, nextBefore } = await api(`/api/highlights?limit=${PAGE_SIZE}`);
        this.items = items || [];
        this.nextBefore = nextBefore ?? null;
      } catch (e) {
        this.error = e.message || 'failed to load highlights';
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
          `/api/highlights?limit=${PAGE_SIZE}&before=${this.nextBefore}`
        );
        this.items = this.items.concat(items || []);
        this.nextBefore = nextBefore ?? null;
      } catch (e) {
        this.error = e.message || 'failed to load more highlights';
      } finally {
        this.loading = false;
      }
    },
    reset() {
      this.items = [];
      this.nextBefore = null;
      this.error = '';
    },
  },
});
