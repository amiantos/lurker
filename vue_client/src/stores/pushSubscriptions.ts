// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import type { LiveClient, PushLogRow } from '../utils/pushLog.js';

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
    clients: [] as LiveClient[],
  }),
  actions: {
    async fetchLog() {
      const { log } = await api('/api/push/log');
      this.log = log || [];
      this.logLoaded = true;
    },
    async fetchClients() {
      const { clients } = await api('/api/push/clients');
      this.clients = clients || [];
    },
    /** A push to every device, gates skipped; the log gets its rows. */
    async sendTest(): Promise<{ sent: number; dropped: number }> {
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
