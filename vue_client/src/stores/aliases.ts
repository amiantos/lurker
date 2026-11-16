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

// The fetch in flight, and whether the list moved again while it was out. A
// change that lands mid-fetch must not be dropped: the answer on its way may
// predate it, and would put a removed alias back.
let inflight: Promise<void> | null = null;
let stale = false;

// The first load is retried, because nothing else would: until it succeeds the
// composer has no aliases, and `/wii bob` goes to the server as `wii bob`.
const RETRY_AFTER_MS = [2_000, 10_000, 30_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;

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
    fetchAll(): Promise<void> {
      if (inflight) {
        stale = true;
        return inflight;
      }
      this.loading = true;
      this.error = '';
      inflight = (async () => {
        try {
          do {
            stale = false;
            const { aliases } = await api('/api/aliases');
            this.aliases = aliases || [];
            this.loaded = true;
          } while (stale);
        } catch (e: any) {
          this.error = e.message || 'failed to load aliases';
          throw e;
        } finally {
          this.loading = false;
          inflight = null;
        }
      })();
      return inflight;
    },
    /** Load on (re)connect, trying again a few times if the first load fails. */
    load(attempt = 0) {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      this.fetchAll().catch(() => {
        const wait = RETRY_AFTER_MS[attempt];
        if (this.loaded || wait === undefined) return;
        retryTimer = setTimeout(() => this.load(attempt + 1), wait);
      });
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
