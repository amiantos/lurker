// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import type { AccountRestrictions } from '../../../shared/accountRestrictions.js';
import { api, type ApiError } from '../api.js';
import type { RelayStatus } from '../../../shared/relayStatus.js';
import type { AdminUploader, UploaderDriver } from '../utils/uploaders.js';

export interface AdminUser {
  id: number;
  username: string;
  role?: 'admin' | 'user';
  createdAt: string;
  lastSeenAt?: string | null;
  isPaused?: boolean;
  /** Admin-assigned identd override; null means "derived from the username". */
  ident?: string | null;
  /** What the identd actually answers for this account (#643). */
  effectiveIdent?: string;
  /** Another account answers this same ident — neither one attributes anything. */
  identConflict?: boolean;
  /** What the account may connect to and whether it may upload. */
  restrictions?: AccountRestrictions;
  /**
   * Expiry of this account's outstanding recovery link, or null for none (#855).
   * The link itself is never returned — only its hash is stored — so this can
   * say one exists but can never re-show it.
   */
  recoveryExpiresAt?: string | null;
}

/** A freshly minted recovery link. The URL is shown once and never again. */
export interface AdminRecoveryLink {
  username: string;
  url: string;
  expiresAt: string;
}

/** An address refused for too many failed logins (#1039). */
export interface AdminLoginLockout {
  source: 'web' | 'bouncer';
  address: string;
  /** Seconds until the lockout lifts on its own, as of the fetch. */
  retryAfter: number;
  /** When it lifts on its own (ISO). */
  liftsAt: string;
}

export interface AdminLoginLockoutPolicy {
  maxFailures: number;
  windowMinutes: number;
  backoffMinutes: number;
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

/** Admin → Notifications: the push relay opt-in (lurker-dev/RELAY_PLAN.md §5a). */
export interface AdminPushConfig {
  /** The VAPID public key — what the admin registers with the relay. */
  publicKey: string;
  /** The contact sent with every Web Push; Apple refuses one with no public domain. */
  vapidSubject: { subject: string; appleAccepts: boolean; ignored: string | null };
  /** Transports this server can deliver on ('webpush', 'apns', 'fcm'). */
  transports: string[];
  relay: {
    url: string;
    enabled: boolean;
    devices: number;
    /** push.lurker.chat's answer for this server's key (RELAY_PLAN.md §6.5); null
     *  until the admin opts in or checks — the server doesn't ask before then. */
    status: RelayStatus | null;
  };
}

export type { RelayStatus as AdminRelayStatus } from '../../../shared/relayStatus.js';

export const useAdminStore = defineStore('admin', {
  state: () => ({
    users: [] as AdminUser[],
    // Whether an ident daemon is actually running (built-in identd or the
    // oidentd file). False makes the per-user idents inert — the pane says so.
    // null: the server can't tell (in engine mode ident runs on the engine,
    // out of its sight), so the pane keeps the editor rather than claiming
    // ident is off.
    identdEnabled: false as boolean | null,
    invites: [] as AdminInvite[],
    loginLockouts: [] as AdminLoginLockout[],
    loginLockoutPolicy: null as AdminLoginLockoutPolicy | null,
    uploaders: [] as AdminUploader[],
    uploaderDrivers: [] as UploaderDriver[],
    allowUserDefined: true,
    // Hosted: the uploader is env-managed by the control plane, so the whole
    // management surface is read-only (the routes 409 anyway).
    uploadersManaged: false,
    // The instance upload ceiling in MB (#1131): the most any account may be
    // allowed. Editable on a self-host; the operator's env on a hosted cell.
    uploadCeilingMb: null as number | null,
    // Instance network presets + the network lockdown (#298). Named distinctly
    // from the uploader policy above — the two switches are independent, and
    // conflating them would let a change to one silently move the other.
    networkPresets: [] as AdminNetworkPreset[],
    allowUserDefinedNetworks: true,
    networksLoaded: false,
    push: null as AdminPushConfig | null,
    // push.lurker.chat's answer for this server's key, apart from the rest of the
    // push config (RELAY_PLAN.md §6.5). Status answers arrive from several places
    // at their own pace — the pane's background read, "check", a turn-on — and
    // only ever touch this. Each request takes a number when it starts; an answer
    // is applied unless one from a later request already landed.
    relayStatus: null as RelayStatus | null,
    relayStatusIssued: 0,
    relayStatusLanded: 0,
    // Every toggle takes a number; only the latest toggle's answer is applied, so
    // an older response arriving late can't flip the checkbox back.
    pushMutationSeq: 0,
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
    lockoutsFetchSeq: 0,
    pushFetchSeq: 0,
    loading: false,
    error: '',
  }),
  actions: {
    async fetchUsers() {
      const seq = ++this.usersFetchSeq;
      this.error = '';
      try {
        const { users, identdEnabled } = await api('/api/admin/users');
        // A newer fetch or a local mutation superseded this GET while it was in
        // flight — its payload is stale, so drop it rather than clobber the
        // fresher state.
        if (seq !== this.usersFetchSeq) return;
        this.users = users || [];
        this.identdEnabled = identdEnabled === null ? null : !!identdEnabled;
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
    // Pass null (or '') to fall back to deriving the ident from the username.
    // Patches the changed row from the response so the edit lands immediately,
    // then refetches for the conflict flags (see below).
    async setUserRestrictions(id: number, restrictions: AccountRestrictions) {
      const res = await api(`/api/admin/users/${id}/restrictions`, {
        method: 'PUT',
        body: restrictions,
      });
      const u = this.users.find((x) => x.id === id);
      if (u) u.restrictions = res.restrictions;
    },
    async setUserIdent(id: number, ident: string | null) {
      const res = await api(`/api/admin/users/${id}/ident`, { method: 'PUT', body: { ident } });
      this.usersFetchSeq++;
      const u = this.users.find((x) => x.id === id);
      if (u) {
        u.ident = res.ident ?? null;
        u.effectiveIdent = res.effectiveIdent;
      }
      // identConflict is a property of the whole SET of accounts, not of the one
      // that changed: assigning an override can resolve a duplicate for the other
      // side of the clash too. Only a refetch can know, so ask for one — but
      // SWALLOW its failure. The write already landed; letting a transient GET
      // error propagate would report a successful save as a failed one and
      // invite the admin to retry. The only casualty is a stale conflict badge
      // until the next fetch, and the pane refetches on every mount.
      await this.fetchUsers().catch(() => {
        // fetchUsers sets the SHARED store error before throwing, and the other
        // admin panes render that field — so leaving it set would surface
        // "failed to load users" over whichever pane the admin opens next.
        this.error = '';
      });
      return res as { ident: string | null; effectiveIdent: string };
    },
    // Mint a single-use recovery link for an account (#855). The response is the
    // only place the URL exists, so the caller must surface it immediately —
    // re-reading the store later can only tell you that one is outstanding.
    async createRecoveryLink(id: number) {
      const { recovery } = await api(`/api/admin/users/${id}/recovery`, { method: 'POST' });
      this.usersFetchSeq++;
      const u = this.users.find((x) => x.id === id);
      if (u) u.recoveryExpiresAt = recovery.expiresAt;
      return recovery as AdminRecoveryLink;
    },
    async revokeRecoveryLink(id: number) {
      await api(`/api/admin/users/${id}/recovery`, { method: 'DELETE' });
      this.usersFetchSeq++;
      const u = this.users.find((x) => x.id === id);
      if (u) u.recoveryExpiresAt = null;
    },
    async fetchLoginLockouts() {
      const seq = ++this.lockoutsFetchSeq;
      const { lockouts, policy } = await api('/api/admin/login-lockouts');
      // Superseded by a newer fetch or a clear — a stale list would bring back
      // lockouts that were just lifted.
      if (seq !== this.lockoutsFetchSeq) return;
      this.loginLockouts = lockouts || [];
      this.loginLockoutPolicy = policy || null;
    },
    async clearLoginLockouts() {
      await api('/api/admin/login-lockouts', { method: 'DELETE' });
      this.lockoutsFetchSeq++;
      this.loginLockouts = [];
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
        this.uploadCeilingMb = typeof data.maxUploadMb === 'number' ? data.maxUploadMb : null;
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
    async setUploadCeilingMb(maxUploadMb: number) {
      const data = await api('/api/admin/uploaders/ceiling', {
        method: 'PUT',
        body: { maxUploadMb },
      });
      this.uploadCeilingMb = typeof data.maxUploadMb === 'number' ? data.maxUploadMb : maxUploadMb;
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
    async fetchPush() {
      const seq = ++this.pushFetchSeq;
      const data: AdminPushConfig = await api('/api/admin/push');
      // A save landed meanwhile — this GET predates it.
      if (seq !== this.pushFetchSeq) return;
      this.push = data;
      // The GET's status is only the server's last answer: it seeds the line until
      // a real status answer lands, and never overrides one.
      if (this.relayStatusLanded === 0 && data.relay.status) this.relayStatus = data.relay.status;
    },
    landRelayStatus(seq: number, status: RelayStatus | null) {
      if (seq <= this.relayStatusLanded) return; // a later request's answer is here

      this.relayStatusLanded = seq;
      this.relayStatus = status;
    },
    /** The relay's status for the pane after it loads (only while opted in). */
    async refreshRelayStatus() {
      const seq = ++this.relayStatusIssued;
      const { status } = await api('/api/admin/push/relay/status');
      this.landRelayStatus(seq, status);
    },
    async checkPushRelay() {
      const seq = ++this.relayStatusIssued;
      const data: AdminPushConfig = await api('/api/admin/push/relay/check', { method: 'POST' });
      this.landRelayStatus(seq, data.relay.status);
    },
    async setPushRelayEnabled(enabled: boolean) {
      const mutation = ++this.pushMutationSeq;
      const statusSeq = ++this.relayStatusIssued;
      const latest = () => mutation === this.pushMutationSeq;
      const apply = (data: AdminPushConfig) => {
        this.pushFetchSeq++; // any GET in flight predates this
        this.push = data;
        // A turn-on's answer carries the fresh check; turning off asks nothing.
        if (data.relay.status) this.landRelayStatus(statusSeq, data.relay.status);
      };
      try {
        const data = await api('/api/admin/push/relay', { method: 'PUT', body: { enabled } });
        if (latest()) apply(data);
        return data.removed as number;
      } catch (e) {
        // A refused turn-on (409) carries the relay's answer, which a refetch
        // wouldn't: the relay is still off, so the server doesn't ask. Otherwise
        // refetch before rethrowing, like the networks policy — the checkbox must
        // show what the server holds, not what was attempted. Either way, only for
        // the latest toggle: an older one's answer is history.
        const err = e as ApiError;
        const body = err.data as AdminPushConfig | undefined;
        if (latest()) {
          if (err.status === 409 && body?.relay) apply(body);
          else await this.fetchPush().catch(() => {});
        }
        throw e;
      }
    },
  },
});
