// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The admin panes refetch on every mount (#613), so a slow users/invites GET can
// still be in flight when a local mutation patches the list. These lock in the
// per-resource fetch-generation guard that drops a superseded GET rather than
// letting it resurrect a just-deleted row.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string }) => Promise<unknown>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));

import {
  useAdminStore,
  type AdminUser,
  type AdminInvite,
  type AdminLoginLockout,
  type AdminPushConfig,
} from './admin.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function user(id: number, username: string): AdminUser {
  return { id, username, createdAt: '' };
}

function invite(token: string): AdminInvite {
  return { token, url: '', status: 'pending', createdAt: '', expiresAt: null, usedAt: null };
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
});

describe('admin store — refetch race guard (#613)', () => {
  it('an in-flight users GET cannot resurrect a locally-deleted user', async () => {
    const store = useAdminStore();
    store.users = [user(1, 'a'), user(2, 'b')];
    store.usersLoaded = true;

    // The GET (mount refetch) stays in flight; DELETE resolves immediately.
    const getDefer = deferred<{ users: AdminUser[] }>();
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'DELETE' ? Promise.resolve({}) : getDefer.promise,
    );

    const fetching = store.fetchUsers(); // seq = 1, awaiting the GET
    await store.deleteUser(2); // bumps seq to 2, filters locally
    expect(store.users.map((u) => u.id)).toEqual([1]);

    // The stale GET resolves with the PRE-delete list.
    getDefer.resolve({ users: [user(1, 'a'), user(2, 'b')] });
    await fetching;

    // User 2 must not be back.
    expect(store.users.map((u) => u.id)).toEqual([1]);
  });

  it('an in-flight invites GET cannot drop a locally-created invite', async () => {
    const store = useAdminStore();
    store.invites = [invite('old')];
    store.invitesLoaded = true;

    const getDefer = deferred<{ invites: AdminInvite[] }>();
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'POST' ? Promise.resolve({ invite: invite('new') }) : getDefer.promise,
    );

    const fetching = store.fetchInvites(); // seq = 1, awaiting the GET
    await store.createInvite(); // bumps seq, prepends locally
    expect(store.invites.map((i) => i.token)).toEqual(['new', 'old']);

    // The stale GET resolves without the freshly-created invite.
    getDefer.resolve({ invites: [invite('old')] });
    await fetching;

    expect(store.invites.map((i) => i.token)).toEqual(['new', 'old']);
  });

  it('an in-flight lockouts GET cannot bring back cleared lockouts', async () => {
    const store = useAdminStore();
    const stale = {
      lockouts: [
        { source: 'bouncer', address: '192.0.2.1', retryAfter: 900, liftsAt: '' },
      ] as AdminLoginLockout[],
      policy: null,
    };
    const getDefer = deferred<typeof stale>();
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'DELETE' ? Promise.resolve({ ok: true }) : getDefer.promise,
    );

    const fetching = store.fetchLoginLockouts(); // left over from an earlier mount
    await store.clearLoginLockouts();
    getDefer.resolve(stale);
    await fetching;

    expect(store.loginLockouts).toEqual([]);
  });

  it('a fresh GET with no mutation racing applies normally', async () => {
    const store = useAdminStore();
    h.api.mockResolvedValue({ users: [user(5, 'e')] });
    await store.fetchUsers();
    expect(store.users.map((u) => u.id)).toEqual([5]);
    expect(store.usersLoaded).toBe(true);
  });
});

// The ident write reports on the WRITE, not on the bookkeeping refetch that
// follows it (#643). Getting this backwards tells an admin their save failed
// when it landed, and invites them to retry a write that already applied.
describe('admin store — setUserIdent', () => {
  it('resolves when the write succeeds even if the follow-up refetch fails', async () => {
    const store = useAdminStore();
    store.users = [user(1, 'alice')];
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'PUT'
        ? Promise.resolve({ ok: true, ident: 'ali', effectiveIdent: 'ali' })
        : Promise.reject(new Error('network down')),
    );

    await expect(store.setUserIdent(1, 'ali')).resolves.toMatchObject({ effectiveIdent: 'ali' });
    // The row still shows the value the write returned...
    expect(store.users[0]).toMatchObject({ ident: 'ali', effectiveIdent: 'ali' });
    // ...and no error is left on the SHARED store field for the next pane to
    // render as its own failure.
    expect(store.error).toBe('');
  });

  it('still rejects when the write itself fails', async () => {
    const store = useAdminStore();
    store.users = [user(1, 'alice')];
    h.api.mockRejectedValue(new Error('that ident is already in use by bob'));
    await expect(store.setUserIdent(1, 'bob')).rejects.toThrow(/already in use/);
    expect(store.users[0].ident).toBeUndefined();
  });

  it('refreshes conflict flags from the server after a successful write', async () => {
    // Assigning an override can clear the duplicate badge on the OTHER side of a
    // clash, which only a refetch can know.
    const store = useAdminStore();
    store.users = [
      { ...user(1, 'bob smith'), effectiveIdent: 'bobsmith', identConflict: true },
      { ...user(2, 'bobsmith'), effectiveIdent: 'bobsmith', identConflict: true },
    ];
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'PUT'
        ? Promise.resolve({ ok: true, ident: 'bobs', effectiveIdent: 'bobs' })
        : Promise.resolve({
            users: [
              { ...user(1, 'bob smith'), effectiveIdent: 'bobs', identConflict: false },
              { ...user(2, 'bobsmith'), effectiveIdent: 'bobsmith', identConflict: false },
            ],
          }),
    );

    await store.setUserIdent(1, 'bobs');
    expect(store.users.map((u) => u.identConflict)).toEqual([false, false]);
  });
});

describe('admin store — push relay toggle', () => {
  const push = (enabled: boolean): AdminPushConfig => ({
    publicKey: 'k',
    vapidSubject: { subject: 'https://lurker.example.com', appleAccepts: true, ignored: null },
    transports: ['webpush'],
    relay: { url: 'https://push.lurker.chat', enabled, devices: 0, status: null },
  });

  it('an in-flight GET cannot undo a saved toggle', async () => {
    const store = useAdminStore();
    const getDefer = deferred<AdminPushConfig>();
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'PUT' ? Promise.resolve({ ...push(true), removed: 0 }) : getDefer.promise,
    );

    const fetching = store.fetchPush(); // the pane's mount refetch, still in flight
    await store.setPushRelayEnabled(true);
    getDefer.resolve(push(false)); // read before the save
    await fetching;

    expect(store.push?.relay.enabled).toBe(true);
  });

  it('a failed save refetches, so the pane shows what the server holds', async () => {
    const store = useAdminStore();
    store.push = push(false);
    h.api.mockImplementation((_url: string, opts?: { method?: string }) =>
      opts?.method === 'PUT' ? Promise.reject(new Error('boom')) : Promise.resolve(push(true)),
    );

    await expect(store.setPushRelayEnabled(true)).rejects.toThrow('boom');
    expect(store.push?.relay.enabled).toBe(true);
  });

  it("keeps a refused turn-on's relay answer instead of refetching it away", async () => {
    const store = useAdminStore();
    store.push = push(false);
    const refused = {
      ...push(false),
      relay: { ...push(false).relay, status: { state: 'inactive', registered: false } },
    };
    h.api.mockImplementation((_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PUT') {
        const err = Object.assign(new Error('not recognized'), { status: 409, data: refused });
        return Promise.reject(err);
      }
      return Promise.resolve(push(false)); // a refetch would lose the status
    });
    await expect(store.setPushRelayEnabled(true)).rejects.toThrow('not recognized');
    expect(store.push?.relay.status).toEqual({ state: 'inactive', registered: false });
  });

  const status = (paidThrough: string) =>
    ({ state: 'active', comped: false, paidThrough }) as const;
  const withStatus = (enabled: boolean, s: unknown) => ({
    ...push(enabled),
    relay: { ...push(enabled).relay, status: s },
  });

  it('a status answer never touches the toggle', async () => {
    const store = useAdminStore();
    store.push = push(true);
    h.api.mockImplementation(() =>
      Promise.resolve(withStatus(false, status('2027-10-06T00:00:00Z'))),
    );
    await store.checkPushRelay();
    expect(store.relayStatus).toEqual(status('2027-10-06T00:00:00Z'));
    expect(store.push?.relay.enabled).toBe(true);
  });

  it('shows a background refresh that lands after the pane loaded', async () => {
    const store = useAdminStore();
    h.api.mockImplementation(
      (url: string) =>
        url.endsWith('/relay/status')
          ? Promise.resolve({ status: status('2027-10-06T00:00:00Z') })
          : Promise.resolve(push(true)), // a restart: the GET has no status yet
    );
    await store.fetchPush();
    expect(store.relayStatus).toBeNull();
    await store.refreshRelayStatus();
    expect(store.relayStatus).toEqual(status('2027-10-06T00:00:00Z'));
  });

  it("check → reload the pane → check completes: the check's answer stands", async () => {
    const store = useAdminStore();
    let answerCheck!: (v: unknown) => void;
    h.api.mockImplementation((url: string) => {
      if (url.endsWith('/relay/check')) return new Promise((r) => (answerCheck = r));
      return Promise.resolve(withStatus(false, { state: 'unreachable', reason: 'old' }));
    });
    const checking = store.checkPushRelay();
    await store.fetchPush(); // leave and come back: a plain GET
    answerCheck(withStatus(false, status('2027-10-06T00:00:00Z')));
    await checking;
    expect(store.relayStatus).toEqual(status('2027-10-06T00:00:00Z'));
  });

  it('an older status answer landing late never replaces a newer one', async () => {
    const store = useAdminStore();
    const answers: ((v: unknown) => void)[] = [];
    h.api.mockImplementation(() => new Promise((r) => answers.push(r)));
    const first = store.checkPushRelay();
    const second = store.refreshRelayStatus();
    answers[1]({ status: status('2028-01-01T00:00:00Z') }); // the newer request
    answers[0](withStatus(false, status('2027-10-06T00:00:00Z'))); // the older, late
    await Promise.all([first, second]);
    expect(store.relayStatus).toEqual(status('2028-01-01T00:00:00Z'));
  });

  it("a plain GET's status seeds the line but never overrides a landed answer", async () => {
    const store = useAdminStore();
    h.api.mockImplementation((url: string) =>
      url.endsWith('/relay/check')
        ? Promise.resolve(withStatus(false, status('2027-10-06T00:00:00Z')))
        : Promise.resolve(withStatus(false, { state: 'unreachable', reason: 'cached' })),
    );
    await store.checkPushRelay();
    await store.fetchPush();
    expect(store.relayStatus).toEqual(status('2027-10-06T00:00:00Z'));
  });

  it('ON(a) → ON(b) → 200(b) → 409 superseded(a): stays on', async () => {
    const store = useAdminStore();
    store.push = push(false);
    const answers: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
    h.api.mockImplementation(
      () => new Promise((resolve, reject) => answers.push({ resolve, reject })),
    );
    const a = store.setPushRelayEnabled(true);
    const b = store.setPushRelayEnabled(true);
    answers[1].resolve({ ...withStatus(true, status('2027-10-06T00:00:00Z')), removed: 0 });
    await b;
    expect(store.push?.relay.enabled).toBe(true);
    answers[0].reject(
      Object.assign(new Error('Conflict'), {
        status: 409,
        data: { code: 'superseded', ...withStatus(false, status('2027-10-06T00:00:00Z')) },
      }),
    );
    await expect(a).rejects.toThrow('Conflict');
    expect(store.push?.relay.enabled).toBe(true);
  });
});

// 'unknown' is the server saying it can't tell (the engine's ident is out of
// its sight, #1138), and folding it to 'off' would hide the ident editor. So
// would reading an answer this client doesn't know as off.
describe('admin store — ident', () => {
  it.each([
    { status: 'on', host: 'server' },
    { status: 'off', host: 'engine' },
    { status: 'failed', host: 'engine' },
    { status: 'unknown', host: 'engine' },
  ])('keeps the server answer $status on the $host as given', async (answer) => {
    h.api.mockResolvedValueOnce({ users: [], ident: answer });
    const store = useAdminStore();
    await store.fetchUsers();
    expect(store.ident).toEqual(answer);
  });

  it.each([undefined, null, {}, { status: 'paused', host: 'moon' }])(
    'reads %j as unknown, never off',
    async (answer) => {
      h.api.mockResolvedValueOnce({ users: [], ident: answer });
      const store = useAdminStore();
      await store.fetchUsers();
      expect(store.ident).toEqual({ status: 'unknown', host: 'server' });
    },
  );
});
