// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// The store's half of the login-loop fix: it owns the one and only signal that
// re-arms api.ts's stale-session bounce — a session that demonstrably exists.
// Mock the api module so this exercises that decision without a network.
const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: unknown) => Promise<any>>(),
  clearAuthRecoveryGuard: vi.fn<() => void>(),
  resetSession: vi.fn<() => void>(),
  startRegistration: vi.fn<() => Promise<unknown>>(),
  startAuthentication: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('../api.js', () => ({
  api: h.api,
  clearAuthRecoveryGuard: h.clearAuthRecoveryGuard,
}));
vi.mock('../composables/useSessionReset.js', () => ({ resetSession: h.resetSession }));
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: h.startRegistration,
  startAuthentication: h.startAuthentication,
}));

const { useAuthStore } = await import('./auth.js');

const USER = { id: 1, username: 'brad', role: 'user' as const };

describe('auth store — stale-session guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.api.mockReset();
    h.clearAuthRecoveryGuard.mockReset();
    h.resetSession.mockReset();
    h.startRegistration.mockReset().mockResolvedValue({ id: 'cred' });
    h.startAuthentication.mockReset().mockResolvedValue({ id: 'cred' });
  });

  it('re-arms the bounce only when /api/auth/me returns a user', async () => {
    h.api.mockResolvedValue({ user: USER });
    await useAuthStore().fetchMe();
    expect(h.clearAuthRecoveryGuard).toHaveBeenCalledTimes(1);
  });

  it('leaves the bounce disarmed when the session is dead', async () => {
    // The loop case: a logged-out load must not re-arm, or the next 401 bounces
    // again and the tab reloads forever.
    h.api.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    const auth = useAuthStore();
    await auth.fetchMe();
    expect(auth.user).toBeNull();
    expect(auth.checked).toBe(true);
    expect(h.clearAuthRecoveryGuard).not.toHaveBeenCalled();
  });

  it('re-arms on a fresh sign-in, so a later session loss still recovers', async () => {
    h.api.mockResolvedValue({ user: USER });
    await useAuthStore().loginWithPassword({ username: 'brad', password: 'hunter22' });
    expect(h.clearAuthRecoveryGuard).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent fetchMe callers into one request', async () => {
    // The router guard and App.vue's boot both fire on a fresh load; two
    // /api/auth/me calls double this tab's spend against the auth rate limiter.
    h.api.mockResolvedValue({ user: USER });
    const auth = useAuthStore();
    const [a, b] = await Promise.all([auth.fetchMe(), auth.fetchMe()]);
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(a).toEqual(USER);
    expect(b).toEqual(USER);
  });

  it('latches "logged out" only on a 401', async () => {
    h.api.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
    const auth = useAuthStore();
    await auth.fetchMe();
    expect(auth.checked).toBe(true);
  });

  it.each([
    ['a network blip', undefined],
    ['a 500', 500],
    ['a 429 from the auth limiter', 429],
  ])(
    'leaves the session unresolved on %s so a later navigation retries',
    async (_label, status) => {
      // This page load now gets exactly one /api/auth/me (guard + App.vue are
      // coalesced), so latching here would strand a signed-in user at
      // /login?next=/ for the whole document off a single blip.
      h.api.mockRejectedValue(Object.assign(new Error('failed'), status ? { status } : {}));
      const auth = useAuthStore();
      await auth.fetchMe();
      expect(auth.checked).toBe(false);

      h.api.mockResolvedValue({ user: USER });
      await auth.fetchMe();
      expect(auth.user).toEqual(USER);
      expect(auth.checked).toBe(true);
    },
  );

  it('keeps a signed-in user signed in across a transient failure', async () => {
    h.api.mockResolvedValue({ user: USER });
    const auth = useAuthStore();
    await auth.fetchMe();

    h.api.mockRejectedValue(Object.assign(new Error('network error'), { status: 503 }));
    await auth.fetchMe();
    expect(auth.user).toEqual(USER);
  });

  it('does not latch the in-flight promise after it settles', async () => {
    h.api.mockResolvedValue({ user: USER });
    const auth = useAuthStore();
    await auth.fetchMe();
    await auth.fetchMe();
    expect(h.api).toHaveBeenCalledTimes(2);
  });
});

// Every path that establishes a session routes through adoptSession(), so each
// one has to re-arm the bounce. A path that forgot would leave a user who
// bounced once unable to recover from any LATER session loss in that tab —
// silent, and invisible until the next stale session.
describe('auth store — every session-establishing path re-arms', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.api.mockReset().mockResolvedValue({ user: USER, options: {} });
    h.clearAuthRecoveryGuard.mockReset();
    h.resetSession.mockReset();
    h.startRegistration.mockReset().mockResolvedValue({ id: 'cred' });
    h.startAuthentication.mockReset().mockResolvedValue({ id: 'cred' });
  });

  it.each([
    ['loginWithPasskey', (a: any) => a.loginWithPasskey()],
    ['loginWithPassword', (a: any) => a.loginWithPassword({ username: 'brad', password: 'pw' })],
    ['setupFirstPasskey', (a: any) => a.setupFirstPasskey({ username: 'brad' })],
    [
      'setupFirstPassword',
      (a: any) => a.setupFirstPassword({ username: 'brad', password: 'hunter22' }),
    ],
    ['acceptInvite', (a: any) => a.acceptInvite({ token: 't', username: 'brad' })],
    [
      'acceptInviteWithPassword',
      (a: any) => a.acceptInviteWithPassword({ token: 't', username: 'brad', password: 'pw' }),
    ],
  ])('%s adopts the session and re-arms the bounce', async (_name, run) => {
    const auth = useAuthStore();
    await run(auth);
    expect(auth.user).toEqual(USER);
    expect(auth.checked).toBe(true);
    expect(h.clearAuthRecoveryGuard).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['setupFirstPasskey', (a: any) => a.setupFirstPasskey({ username: 'brad' })],
    [
      'setupFirstPassword',
      (a: any) => a.setupFirstPassword({ username: 'brad', password: 'hunter22' }),
    ],
  ])('%s clears the first-run prompt', async (_name, run) => {
    const auth = useAuthStore();
    await run(auth);
    expect(auth.setupStatus).toEqual({ needsSetup: false });
  });

  it.each([
    ['acceptInvite', (a: any) => a.acceptInvite({ token: 't', username: 'brad' })],
    [
      'acceptInviteWithPassword',
      (a: any) => a.acceptInviteWithPassword({ token: 't', username: 'brad', password: 'pw' }),
    ],
  ])('%s wipes the prior user BEFORE adopting the new session', async (_name, run) => {
    // Ordering is load-bearing: resetSession() must see a null user so the WS
    // onclose handler skips its reconnect arm. adoptSession() moved the
    // assignment, so pin the order down rather than trust the read.
    const auth = useAuthStore();
    auth.user = { id: 9, username: 'previous', role: 'user' };
    let userAtReset: unknown = 'not called';
    h.resetSession.mockImplementation(() => {
      userAtReset = auth.user;
    });

    await run(auth);

    expect(h.resetSession).toHaveBeenCalledTimes(1);
    expect(userAtReset).toBeNull();
    expect(auth.user).toEqual(USER);
  });
});

describe('auth store — account restrictions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('reads an older server (no field) as unrestricted', () => {
    const store = useAuthStore();
    store.adoptSession({ ...USER });
    expect(store.allowedNetworkHosts).toBeNull();
    expect(store.canUpload).toBe(true);
  });

  it('exposes the host list and the upload switch from /me', () => {
    const store = useAuthStore();
    store.adoptSession({
      ...USER,
      restrictions: { networks: ['irc.lurker.chat'], uploads: false },
    });
    expect(store.allowedNetworkHosts).toStrictEqual(['irc.lurker.chat']);
    expect(store.canUpload).toBe(false);
  });

  it('replaces the set live from account-state', () => {
    const store = useAuthStore();
    store.adoptSession({
      ...USER,
      restrictions: { networks: ['irc.lurker.chat'], uploads: false },
    });
    store.setRestrictions({ networks: null, uploads: true });
    expect(store.allowedNetworkHosts).toBeNull();
    expect(store.canUpload).toBe(true);
  });
});
