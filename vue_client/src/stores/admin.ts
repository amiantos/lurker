// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { api } from '../api.js';
import type { AdminUploader, UploaderDriver } from '../utils/uploaders.js';

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
    uploaders: [] as AdminUploader[],
    uploaderDrivers: [] as UploaderDriver[],
    allowUserDefined: true,
    // Hosted: the uploader is env-managed by the control plane, so the whole
    // management surface is read-only (the routes 409 anyway).
    uploadersManaged: false,
    usersLoaded: false,
    invitesLoaded: false,
    uploadersLoaded: false,
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

    // ─── instance uploaders (#514) ───────────────────────────────────────────
    // Every mutation refetches rather than patching locally: the policy flags are
    // interdependent server-side (setting one default clears the incumbent), so a
    // local patch would drift from the truth on the very first default swap.
    async fetchUploaders() {
      this.error = '';
      try {
        const data = await api('/api/admin/uploaders');
        this.uploaders = data.uploaders || [];
        this.uploaderDrivers = data.drivers || [];
        this.allowUserDefined = data.allowUserDefined !== false;
        this.uploadersManaged = !!data.managed;
        this.uploadersLoaded = true;
      } catch (e: any) {
        this.error = e.message || 'failed to load uploaders';
        throw e;
      }
    },
    async createUploader(body: { driver: string; label: string; values: Record<string, string> }) {
      await api('/api/admin/uploaders', { method: 'POST', body });
      await this.fetchUploaders();
    },
    async updateUploader(
      id: number,
      body: {
        label?: string;
        values?: Record<string, string>;
        enabled?: boolean;
        offeredToUsers?: boolean;
      },
    ) {
      await api(`/api/admin/uploaders/${id}`, { method: 'PATCH', body });
      await this.fetchUploaders();
    },
    async setDefaultUploader(id: number) {
      await api(`/api/admin/uploaders/${id}/default`, { method: 'PUT' });
      await this.fetchUploaders();
    },
    async deleteUploader(id: number) {
      await api(`/api/admin/uploaders/${id}`, { method: 'DELETE' });
      await this.fetchUploaders();
    },
    async setAllowUserDefined(allowUserDefined: boolean) {
      await api('/api/admin/uploaders/policy', {
        method: 'PUT',
        body: { allowUserDefined },
      });
      this.allowUserDefined = allowUserDefined;
    },
  },
});
