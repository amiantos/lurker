// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import { REGISTRY, getDefault } from '../utils/settingsRegistry.js';

function valuesEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    values: {},
    loaded: false,
    loading: null,
  }),
  getters: {
    registry: () => REGISTRY,
    effective(state) {
      return (key) => (key in state.values ? state.values[key] : getDefault(key));
    },
    isModified(state) {
      return (key) => {
        if (!(key in state.values)) return false;
        // Defensive: the server normally drops rows whose value equals the
        // default, but stale rows can survive from older versions. Treat
        // them as unmodified so the UI stays correct.
        return !valuesEqual(state.values[key], getDefault(key));
      };
    },
  },
  actions: {
    async fetchAll() {
      if (this.loading) return this.loading;
      this.loading = (async () => {
        const { values } = await api('/api/settings/bootstrap');
        this.values = { ...(values || {}) };
        this.loaded = true;
      })();
      try {
        await this.loading;
        this.syncDetectedTimezone().catch(() => {});
      } finally {
        this.loading = null;
      }
    },
    // The server uses system.timezone when formatting time strings for the
    // user (e.g. the timestamp baked into the auto-away message), and that
    // formatting runs when no client is connected — so the value has to live
    // server-side. Push the browser's current zone on every bootstrap so the
    // setting tracks the user across devices and travel.
    async syncDetectedTimezone() {
      let detected;
      try {
        detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return;
      }
      if (!detected) return;
      const current = this.values['system.timezone'];
      if (current === detected) return;
      try {
        await this.setValue('system.timezone', detected);
      } catch {
        // Non-critical — fall through silently.
      }
    },
    async setValue(key, value) {
      const { values } = await api('/api/settings', {
        method: 'PATCH',
        body: { changes: { [key]: value } },
      });
      this.values = { ...(values || {}) };
    },
    async reset(key) {
      const { values } = await api(`/api/settings/${encodeURIComponent(key)}`, { method: 'DELETE' });
      this.values = { ...(values || {}) };
    },
    applyRemote({ changes }) {
      if (!changes) return;
      const next = { ...this.values };
      for (const [key, value] of Object.entries(changes)) {
        const def = getDefault(key);
        if (def !== undefined && valuesEqual(value, def)) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      this.values = next;
    },
  },
});
