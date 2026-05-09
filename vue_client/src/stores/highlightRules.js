import { defineStore } from 'pinia';
import { api } from '../api.js';

export const useHighlightRulesStore = defineStore('highlightRules', {
  state: () => ({
    rules: [],
    loaded: false,
    loading: false,
    error: '',
  }),
  getters: {
    userRules: (state) => state.rules.filter((r) => r.auto_managed_network_id == null),
    autoRules: (state) => state.rules.filter((r) => r.auto_managed_network_id != null),
  },
  actions: {
    async fetchAll() {
      if (this.loading) return;
      this.loading = true;
      this.error = '';
      try {
        const { rules } = await api('/api/highlight-rules');
        this.rules = rules || [];
        this.loaded = true;
      } catch (e) {
        this.error = e.message || 'failed to load rules';
        throw e;
      } finally {
        this.loading = false;
      }
    },
    async create(fields) {
      const { rule } = await api('/api/highlight-rules', { method: 'POST', body: fields });
      this.rules.push(rule);
      return rule;
    },
    async update(id, fields) {
      const { rule } = await api(`/api/highlight-rules/${id}`, { method: 'PATCH', body: fields });
      const idx = this.rules.findIndex((r) => r.id === id);
      if (idx >= 0) this.rules[idx] = rule;
      return rule;
    },
    async remove(id) {
      await api(`/api/highlight-rules/${id}`, { method: 'DELETE' });
      this.rules = this.rules.filter((r) => r.id !== id);
    },
    applyServerChanged() {
      // Re-fetch when the server signals rules changed (rare; another tab edited).
      this.fetchAll().catch(() => { /* ignore */ });
    },
  },
});
