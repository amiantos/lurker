// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import type { Alias } from '../../../shared/aliases.js';

// Command aliases (#276). The server keeps the list; the composer expands them
// (MessageInput's handleCommand), and both `/alias` and the Settings pane edit
// it through here. CRUD is REST; the server fans `aliases-changed` so other
// sessions re-fetch.

const path = (name: string): string => `/api/aliases/${encodeURIComponent(name)}`;
const byName = (a: Alias, b: Alias): number => a.name.localeCompare(b.name);

export const useAliasesStore = defineStore('aliases', {
  state: () => ({
    aliases: [] as Alias[],
    loaded: false,
    loading: false,
    error: '',
  }),
  getters: {
    /** The alias a typed verb names, slash or not, any case. */
    find:
      (state) =>
      (verb: string): Alias | undefined => {
        const name = verb.replace(/^\//, '').toLowerCase();
        return state.aliases.find((a) => a.name === name);
      },
  },
  actions: {
    async fetchAll() {
      if (this.loading) return;
      this.loading = true;
      this.error = '';
      try {
        const { aliases } = await api('/api/aliases');
        this.aliases = aliases || [];
        this.loaded = true;
      } catch (e: any) {
        this.error = e.message || 'failed to load aliases';
        throw e;
      } finally {
        this.loading = false;
      }
    },
    /** Define an alias, or replace the one of that name. */
    async set(name: string, body: string): Promise<{ alias: Alias; created: boolean }> {
      const { alias, created } = await api(path(name), { method: 'PUT', body: { body } });
      this.aliases = [...this.aliases.filter((a) => a.name !== alias.name), alias].sort(byName);
      return { alias, created };
    },
    /** Edit one in place: a new name, a new body, or both. */
    async update(name: string, fields: { name?: string; body?: string }): Promise<Alias> {
      const { alias } = await api(path(name), { method: 'PATCH', body: fields });
      this.aliases = [
        ...this.aliases.filter((a) => a.name !== name && a.name !== alias.name),
        alias,
      ].sort(byName);
      return alias as Alias;
    },
    async remove(name: string) {
      await api(path(name), { method: 'DELETE' });
      this.aliases = this.aliases.filter((a) => a.name !== name);
    },
    applyServerChanged() {
      this.fetchAll().catch(() => {
        /* the list as it stood keeps working */
      });
    },
  },
});
