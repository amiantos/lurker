// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import type { LiveClient, PushLogRow } from '../utils/pushLog.js';

/** The server's default page; a full page means there may be more. */
const LOG_PAGE = 100;

export interface PushSubscription {
  endpoint: string;
  label: string | null;
  createdAt: string;
}

export const usePushSubscriptionsStore = defineStore('pushSubscriptions', {
  state: () => ({
    subscriptions: [] as PushSubscription[],
    loaded: false,
    loading: false,
    error: '',
    // The push log and live clients (#1272), for Settings → Notifications.
    log: [] as PushLogRow[],
    logLoaded: false,
    // False once a page came back short: there is no older row to ask for.
    logHasMore: false,
    clients: [] as LiveClient[],
    // Answers land in request order or not at all: the test button refetches
    // while the pane's first load may still be in flight, and the older answer
    // must not overwrite the newer.
    logSeq: 0,
    clientsSeq: 0,
  }),
  actions: {
    async fetchLog() {
      const seq = ++this.logSeq;
      const { log } = await api('/api/push/log');
      if (seq !== this.logSeq) return;
      this.log = log || [];
      this.logLoaded = true;
      this.logHasMore = this.log.length >= LOG_PAGE;
    },
    /** The page below what's shown, appended. */
    async fetchOlderLog() {
      const last = this.log.at(-1);
      if (!last) return;
      const seq = ++this.logSeq;
      const { log } = await api(`/api/push/log?before=${last.id}`);
      if (seq !== this.logSeq) return;
      const older: PushLogRow[] = log || [];
      this.log = [...this.log, ...older];
      this.logHasMore = older.length >= LOG_PAGE;
    },
    async fetchClients() {
      const seq = ++this.clientsSeq;
      const { clients } = await api('/api/push/clients');
      if (seq !== this.clientsSeq) return;
      this.clients = clients || [];
    },
    /** A push to every device, gates skipped; the log gets its rows. */
    async sendTest(): Promise<{
      sent: number;
      dropped: number;
      devices: number;
      disabled: number;
    }> {
      const result = await api('/api/push/test', { method: 'POST' });
      await this.fetchLog().catch(() => {});
      return result;
    },
    async fetchAll() {
      if (this.loading) return;
      this.loading = true;
      this.error = '';
      try {
        const { subscriptions } = await api('/api/push/subscriptions');
        this.subscriptions = subscriptions || [];
        this.loaded = true;
      } catch (e: any) {
        this.error = e.message || 'failed to load subscriptions';
        throw e;
      } finally {
        this.loading = false;
      }
    },
    async removeByEndpoint(endpoint: string) {
      await api('/api/push/subscriptions', { method: 'DELETE', body: { endpoint } });
      this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    },
  },
});
