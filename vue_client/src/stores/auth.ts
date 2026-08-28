// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { api, clearAuthRecoveryGuard } from '../api.js';
import { resetSession } from '../composables/useSessionReset.js';
import { useConfigStore } from './config.js';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
  // Read-only account: still authenticated and able to browse history, but
  // disconnected from IRC and barred from sending. Seeded by /api/auth/me and
  // flipped live by the server's 'account-state' WS event (see setPaused).
  is_paused?: boolean;
}

export interface SetupStatus {
  needsSetup: boolean;
  mode?: string;
  username?: string;
}

export interface Passkey {
  id: string;
  label: string | null;
  createdAt: string;
}

// Shared in-flight fetch so concurrent callers — the router guard and App.vue's
// boot — coalesce onto one GET /api/auth/me instead of each spending a request
// against the auth-surface rate limiter. Module-scoped (not store state) so it
// stays non-reactive, matching the config store.
let inflight: Promise<AuthUser | null> | null = null;

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as AuthUser | null,
    checked: false,
    error: null as string | null,
    setupStatus: null as SetupStatus | null, // { needsSetup, mode?, username? }
  }),
  getters: {
    // Whole-UI read-only gate. Components key their disabled/banner state off
    // this rather than poking at user?.is_paused directly.
    isPaused: (s): boolean => s.user?.is_paused === true,
    // Instance-admin gate. Every admin-only surface (Settings "Users" category,
    // the admin panel + its entry buttons, the /admin route guard) keys off this
    // rather than re-deriving `user?.role === 'admin'` at each call site.
    isAdmin: (s): boolean => s.user?.role === 'admin',
  },
  actions: {
    // Adopt a freshly-established session. Every sign-in / setup / invite path
    // lands here rather than assigning `user` itself, so none of them can forget
    // to re-arm api.ts's one-shot stale-session bounce: without the clear, a tab
    // that bounced once and then signed in would never recover from a LATER
    // session loss.
    adoptSession(user: AuthUser) {
      this.user = user;
      this.checked = true;
      clearAuthRecoveryGuard();
    },
    // Live flip from the server's 'account-state' WS event, so an open tab
    // enters/leaves read-only without a reload.
    setPaused(paused: boolean) {
      if (this.user) this.user.is_paused = paused;
    },
    async fetchMe() {
      if (inflight) return inflight; // a fetch is in flight — share its result
      inflight = (async () => {
        try {
          const { user } = await api('/api/auth/me');
          this.user = user;
          this.checked = true;
          // A live session is the ONLY thing that re-arms api.ts's one-shot
          // stale-session bounce. Anything weaker (any 2xx) disarms it on a
          // logged-out page and loops the tab — see clearAuthRecoveryGuard.
          if (user) clearAuthRecoveryGuard();
        } catch (err: any) {
          // Only a 401 proves "not signed in". A network blip, a 5xx, or a 429
          // from the auth-surface limiter says nothing about the session — and
          // since the guard and App.vue now share one coalesced call, a page
          // load gets exactly one attempt. Latching `checked` on those would
          // strand a signed-in user at /login?next=/ for the whole document off
          // a single blip. Leave it false so a later navigation retries, the
          // same self-heal the config store uses.
          if (err?.status === 401) {
            this.user = null;
            this.checked = true;
          }
        }
        return this.user;
      })();
      try {
        return await inflight;
      } finally {
        inflight = null;
      }
    },
    // On a hosted cell the account's real identity — its email — lives on the
    // control plane; the cell only knows a synthetic `acct-N` username. This
    // same-origin GET carries cp_session and returns the email so the UI can
    // show something meaningful. Returns null off the hosted service (the
    // endpoint 404s) or if the session can't be read, so callers fall back.
    async fetchHostedAccountEmail(): Promise<string | null> {
      try {
        const { account } = await api('/_cp/auth/me');
        return account?.email ?? null;
      } catch (_err) {
        return null;
      }
    },
    async fetchSetupStatus() {
      try {
        this.setupStatus = await api('/api/auth/setup-status');
      } catch (_err) {
        this.setupStatus = { needsSetup: false };
      }
      return this.setupStatus;
    },
    async fetchAuthMethods() {
      try {
        return await api('/api/auth/auth-methods');
      } catch (_err) {
        return { passkey: false };
      }
    },
    async loginWithPasskey() {
      this.error = null;
      try {
        const { options } = await api('/api/auth/login/options', { method: 'POST' });
        const response = await startAuthentication({ optionsJSON: options });
        const { user } = await api('/api/auth/login/verify', {
          method: 'POST',
          body: { response },
        });
        this.adoptSession(user);
        return user as AuthUser;
      } catch (err: any) {
        this.error = friendlyError(err, 'login failed');
        throw err;
      }
    },
    async setupFirstPasskey({ username }: { username?: string } = {}) {
      this.error = null;
      try {
        const { options } = await api('/api/auth/setup/options', {
          method: 'POST',
          body: { username },
        });
        const response = await startRegistration({ optionsJSON: options });
        const { user } = await api('/api/auth/setup/verify', {
          method: 'POST',
          body: { response },
        });
        this.adoptSession(user);
        this.setupStatus = { needsSetup: false };
        return user as AuthUser;
      } catch (err: any) {
        this.error = friendlyError(err, 'setup failed');
        throw err;
      }
    },
    async setupFirstPassword({
      username,
      password,
    }: { username?: string; password?: string } = {}) {
      this.error = null;
      try {
        const { user } = await api('/api/auth/setup/password', {
          method: 'POST',
          body: { username, password },
        });
        this.adoptSession(user);
        this.setupStatus = { needsSetup: false };
        return user as AuthUser;
      } catch (err: any) {
        this.error = friendlyError(err, 'setup failed');
        throw err;
      }
    },
    async loginWithPassword({ username, password }: { username?: string; password?: string } = {}) {
      this.error = null;
      try {
        const { user } = await api('/api/auth/login/password', {
          method: 'POST',
          body: { username, password },
        });
        this.adoptSession(user);
        return user as AuthUser;
      } catch (err: any) {
        this.error = friendlyError(err, 'login failed');
        throw err;
      }
    },
    async fetchInviteStatus(token: string) {
      // Public endpoint, never throws on a missing/expired token — returns
      // { valid: bool, expired?: bool } so the landing page can pick its copy.
      const data = await api(`/api/auth/invite/${encodeURIComponent(token)}`);
      return data;
    },
    async acceptInvite({
      token,
      username,
      label,
    }: { token?: string; username?: string; label?: string } = {}) {
      this.error = null;
      try {
        const { options } = await api(`/api/auth/invite/${encodeURIComponent(token!)}/options`, {
          method: 'POST',
          body: { username },
        });
        const response = await startRegistration({ optionsJSON: options });
        const { user } = await api(`/api/auth/invite/${encodeURIComponent(token!)}/verify`, {
          method: 'POST',
          body: { response, label },
        });
        // If a prior user was logged into this browser, wipe their state
        // before the new session takes over. Clear `user` first so the WS
        // onclose reconnect arm sees no user (matches the logout pattern).
        this.user = null;
        resetSession();
        this.adoptSession(user);
        return user as AuthUser;
      } catch (err: any) {
        this.error = friendlyError(err, 'invite redemption failed');
        throw err;
      }
    },
    async acceptInviteWithPassword({
      token,
      username,
      password,
    }: { token?: string; username?: string; password?: string } = {}) {
      this.error = null;
      try {
        const { user } = await api(`/api/auth/invite/${encodeURIComponent(token!)}/password`, {
          method: 'POST',
          body: { username, password },
        });
        this.user = null;
        resetSession();
        this.adoptSession(user);
        return user as AuthUser;
      } catch (err: any) {
        this.error = friendlyError(err, 'invite redemption failed');
        throw err;
      }
    },
    // --- account recovery (#855) ---
    // An admin-issued link for an account its owner is locked out of. Both
    // redemption paths mint a fresh session and, server-side, sign every other
    // device out.
    async fetchRecoveryStatus(token: string) {
      // Public endpoint, never throws on a dead token — { valid: false } covers
      // "expired", "already used" and "never existed" alike.
      return await api(`/api/auth/recovery/${encodeURIComponent(token)}`);
    },
    async recoverWithPassword({ token, password }: { token?: string; password?: string } = {}) {
      this.error = null;
      try {
        const { user } = await api(`/api/auth/recovery/${encodeURIComponent(token!)}/password`, {
          method: 'POST',
          body: { password },
        });
        // A different account may have been signed in on this browser — wipe
        // its state before the new session takes over, as invite redemption does.
        this.user = null;
        resetSession();
        this.adoptSession(user);
        return user as AuthUser;
      } catch (err: any) {
        this.error = friendlyError(err, 'account recovery failed');
        throw err;
      }
    },
    async recoverWithPasskey({ token, label }: { token?: string; label?: string } = {}) {
      this.error = null;
      try {
        const { options } = await api(`/api/auth/recovery/${encodeURIComponent(token!)}/options`, {
          method: 'POST',
        });
        const response = await startRegistration({ optionsJSON: options });
        const { user } = await api(`/api/auth/recovery/${encodeURIComponent(token!)}/verify`, {
          method: 'POST',
          body: { response, label },
        });
        this.user = null;
        resetSession();
        this.adoptSession(user);
        return user as AuthUser;
      } catch (err: any) {
        this.error = friendlyError(err, 'account recovery failed');
        throw err;
      }
    },
    async addPasskey({ label }: { label?: string } = {}) {
      const { options } = await api('/api/auth/passkeys/options', { method: 'POST' });
      const response = await startRegistration({ optionsJSON: options });
      const { passkey } = await api('/api/auth/passkeys/verify', {
        method: 'POST',
        body: { response, label },
      });
      return passkey as Passkey;
    },
    async listPasskeys() {
      const { passkeys } = await api('/api/auth/passkeys');
      return passkeys as Passkey[];
    },
    async renamePasskey(id: string, label: string) {
      await api(`/api/auth/passkeys/${id}`, { method: 'PATCH', body: { label } });
    },
    async deletePasskey(id: string) {
      await api(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
    },
    async fetchPasswordStatus() {
      try {
        const { hasPassword } = await api('/api/auth/password');
        return !!hasPassword;
      } catch (_) {
        return false;
      }
    },
    async setPassword({
      password,
      currentPassword,
    }: { password?: string; currentPassword?: string } = {}) {
      await api('/api/auth/password', {
        method: 'PUT',
        body: { password, currentPassword },
      });
    },
    async removePassword() {
      await api('/api/auth/password', { method: 'DELETE' });
    },
    async logout() {
      // Sign-out must clear EVERY session cookie this browser carries, then
      // always end up logged out locally — a failed network call can't be
      // allowed to leave the user stuck signed in. Each call is best-effort.
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch (_err) {
        // ignore — local state is still cleared below
      }
      // On a hosted cell the customer also holds a control-plane session
      // (cp_session) the reverse proxy minted; the cell's logout above only
      // clears its own lurker_session. Both cookies are same-origin and
      // httpOnly, so the browser can't drop cp_session itself — without this
      // the user stays authenticated to the proxy and /billing, making
      // sign-out effectively impossible. /_cp/* is always control-plane-served,
      // never proxied to the cell. Only a hosted cell has a cp_session, so this
      // is gated on node mode — a standalone box has no control plane and we
      // don't fire a doomed request at one. config is fetched at boot, long
      // before any sign-out click, so isNode is reliable here.
      if (useConfigStore().isNode) {
        try {
          await api('/_cp/auth/logout', { method: 'POST' });
        } catch (_err) {
          // ignore — session already gone; local state is still cleared below
        }
      }
      // Clear user before resetSession so any late WS onclose handler sees a
      // null user and skips its 2s reconnect arm.
      this.user = null;
      resetSession();
    },
  },
});

function friendlyError(err: any, fallback: string): string {
  if (!err) return fallback;
  // Browser cancellation comes back as a DOMException; show something less
  // alarming than "NotAllowedError: ...".
  if (err.name === 'NotAllowedError') return 'cancelled';
  if (err.name === 'InvalidStateError') return 'this passkey is already registered';
  return err.message || fallback;
}
