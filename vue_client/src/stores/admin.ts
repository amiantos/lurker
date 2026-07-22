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

/** An admin-defined network preset (#298), as the admin API returns it. */
export interface AdminNetworkPreset {
  id: number;
  name: string;
  host: string;
  port: number;
  tls: boolean;
  saslLikelyRequired: boolean;
  /** Recommended channels, pre-checked for users in the first-run flow. */
  channels: string[];
  enabled: boolean;
  position: number;
}

export type AdminNetworkPresetInput = Omit<AdminNetworkPreset, 'id' | 'position'>;

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
    // Instance network presets + the network lockdown (#298). Named distinctly
    // from the uploader policy above — the two switches are independent, and
    // conflating them would let a change to one silently move the other.
    networkPresets: [] as AdminNetworkPreset[],
    allowUserDefinedNetworks: true,
    networksLoaded: false,
    usersLoaded: false,
    invitesLoaded: false,
    uploadersLoaded: false,
    // Monotonic per-resource fetch generation. The admin panes refetch on every
    // mount (#613), so a slow GET can still be in flight when a local mutation
    // (delete/pause/create/revoke) patches the list. Each fetch captures the seq
    // and drops its payload if a newer fetch OR a mutation bumped it meanwhile —
    // otherwise the stale GET would resurrect a just-deleted row.
    usersFetchSeq: 0,
    invitesFetchSeq: 0,
    loading: false,
    error: '',
  }),
  actions: {
    async fetchUsers() {
      const seq = ++this.usersFetchSeq;
      this.error = '';
      try {
        const { users } = await api('/api/admin/users');
        // A newer fetch or a local mutation superseded this GET while it was in
        // flight — its payload is stale, so drop it rather than clobber the
        // fresher state.
        if (seq !== this.usersFetchSeq) return;
        this.users = users || [];
        this.usersLoaded = true;
      } catch (e: any) {
        if (seq !== this.usersFetchSeq) return;
        this.error = e.message || 'failed to load users';
        throw e;
      }
    },
    async deleteUser(id: number) {
      await api(`/api/admin/users/${id}`, { method: 'DELETE' });
      // Invalidate any in-flight GET so it can't resurrect the deleted row.
      this.usersFetchSeq++;
      this.users = this.users.filter((u) => u.id !== id);
    },
    async pauseUser(id: number) {
      await api(`/api/admin/users/${id}/pause`, { method: 'POST' });
      this.usersFetchSeq++;
      const u = this.users.find((x) => x.id === id);
      if (u) u.isPaused = true;
    },
    async resumeUser(id: number) {
      await api(`/api/admin/users/${id}/resume`, { method: 'POST' });
      this.usersFetchSeq++;
      const u = this.users.find((x) => x.id === id);
      if (u) u.isPaused = false;
    },
    async fetchInvites() {
      const seq = ++this.invitesFetchSeq;
      this.error = '';
      try {
        const { invites } = await api('/api/admin/invites');
        if (seq !== this.invitesFetchSeq) return;
        this.invites = invites || [];
        this.invitesLoaded = true;
      } catch (e: any) {
        if (seq !== this.invitesFetchSeq) return;
        this.error = e.message || 'failed to load invites';
        throw e;
      }
    },
    async createInvite({ expiresInDays }: { expiresInDays?: number } = {}) {
      const { invite } = await api('/api/admin/invites', {
        method: 'POST',
        body: expiresInDays ? { expiresInDays } : {},
      });
      this.invitesFetchSeq++;
      this.invites = [invite, ...this.invites];
      return invite as AdminInvite;
    },
    async deleteInvite(token: string) {
      await api(`/api/admin/invites/${encodeURIComponent(token)}`, { method: 'DELETE' });
      this.invitesFetchSeq++;
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

    // ─── instance network presets (#298) ─────────────────────────────────────
    // Same refetch-on-mutate discipline as the uploaders above: the server
    // refuses some combinations (you can't lock down with no presets, or delete
    // the last one while locked down), so a local patch would drift from truth
    // the first time a write is rejected.
    async fetchNetworkPresets() {
      this.error = '';
      try {
        const data = await api('/api/admin/networks');
        this.networkPresets = data.presets || [];
        this.allowUserDefinedNetworks = data.allowUserDefined !== false;
        this.networksLoaded = true;
      } catch (e: any) {
        this.error = e.message || 'failed to load networks';
        throw e;
      }
    },
    async createNetworkPreset(body: AdminNetworkPresetInput) {
      await api('/api/admin/networks', { method: 'POST', body });
      await this.fetchNetworkPresets();
    },
    async updateNetworkPreset(id: number, body: Partial<AdminNetworkPresetInput>) {
      await api(`/api/admin/networks/${id}`, { method: 'PATCH', body });
      await this.fetchNetworkPresets();
    },
    async deleteNetworkPreset(id: number) {
      await api(`/api/admin/networks/${id}`, { method: 'DELETE' });
      await this.fetchNetworkPresets();
    },
    async setAllowUserDefinedNetworks(allowUserDefined: boolean) {
      await api('/api/admin/networks/policy', { method: 'PUT', body: { allowUserDefined } });
      // Refetch rather than assign: the server 409s this when no presets exist,
      // and the throw must leave the checkbox showing the truth, not the attempt.
      await this.fetchNetworkPresets();
    },
  },
});
