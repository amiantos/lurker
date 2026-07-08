// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';

export interface AdminUser {
  id: number;
  username: string;
  role?: 'admin' | 'user';
  createdAt: string;
  lastSeenAt?: string | null;
  isPaused?: boolean;
}

export interface AdminInvite {
  token: string;
  url: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  usedByUsername?: string | null;
}

export const useAdminStore = defineStore('admin', {
  state: () => ({
    users: [] as AdminUser[],
    invites: [] as AdminInvite[],
    usersLoaded: false,
    invitesLoaded: false,
    loading: false,
    error: '',
  }),
  actions: {
    async fetchUsers() {
      this.error = '';
      try {
        const { users } = await api('/api/admin/users');
        this.users = users || [];
        this.usersLoaded = true;
      } catch (e: any) {
        this.error = e.message || 'failed to load users';
        throw e;
      }
    },
    async deleteUser(id: number) {
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      this.users = this.users.filter((u) => u.id !== id);
    },
    async pauseUser(id: number) {
      await api(`/api/admin/users/${id}/pause`, { method: 'POST' });
      const u = this.users.find((x) => x.id === id);
      if (u) u.isPaused = true;
    },
    async resumeUser(id: number) {
      await api(`/api/admin/users/${id}/resume`, { method: 'POST' });
      const u = this.users.find((x) => x.id === id);
      if (u) u.isPaused = false;
    },
    async fetchInvites() {
      this.error = '';
      try {
        const { invites } = await api('/api/admin/invites');
        this.invites = invites || [];
        this.invitesLoaded = true;
      } catch (e: any) {
        this.error = e.message || 'failed to load invites';
        throw e;
      }
    },
    async createInvite({ expiresInDays }: { expiresInDays?: number } = {}) {
      const { invite } = await api('/api/admin/invites', {
        method: 'POST',
        body: expiresInDays ? { expiresInDays } : {},
      });
      this.invites = [invite, ...this.invites];
      return invite as AdminInvite;
    },
    async deleteInvite(token: string) {
      await api(`/api/admin/invites/${encodeURIComponent(token)}`, { method: 'DELETE' });
      this.invites = this.invites.filter((i) => i.token !== token);
    },
  },
});
