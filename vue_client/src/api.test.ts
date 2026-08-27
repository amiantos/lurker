// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, clearAuthRecoveryGuard, shouldBounceToLogin } from './api.js';

describe('shouldBounceToLogin', () => {
  it('bounces to sign-in on a 401 from a normal authed call', () => {
    expect(shouldBounceToLogin('/api/networks', 401, false, '/')).toBe(true);
    expect(shouldBounceToLogin('/api/buffers/1', 401, false, '/settings/account')).toBe(true);
  });

  it('does not bounce on non-401 statuses', () => {
    expect(shouldBounceToLogin('/api/networks', 403, false, '/')).toBe(false);
    expect(shouldBounceToLogin('/api/networks', 500, false, '/')).toBe(false);
    expect(shouldBounceToLogin('/api/networks', 200, false, '/')).toBe(false);
  });

  it('bounces at most once per tab', () => {
    expect(shouldBounceToLogin('/api/networks', 401, true, '/')).toBe(false);
  });

  it('ignores auth + control-plane endpoints (they 401 by design before sign-in)', () => {
    expect(shouldBounceToLogin('/api/auth/me', 401, false, '/')).toBe(false);
    expect(shouldBounceToLogin('/api/auth/login', 401, false, '/')).toBe(false);
    expect(shouldBounceToLogin('/_cp/auth/logout', 401, false, '/')).toBe(false);
  });

  it('does not bounce off a public page — App.vue settings/config fetches 401 by design when logged out', () => {
    // The invite-link regression: a logged-out visitor on /invite/<token> would
    // otherwise be ejected to /login?next=/ by the background /api/settings 401.
    expect(shouldBounceToLogin('/api/settings/bootstrap', 401, false, '/invite/abc123')).toBe(
      false,
    );
    expect(shouldBounceToLogin('/api/settings/bootstrap', 401, false, '/login')).toBe(false);
    // Same shape for a recovery link (#855): its whole audience is a logged-out
    // visitor, so an ejection here strands the one person the link exists for.
    expect(shouldBounceToLogin('/api/settings/bootstrap', 401, false, '/recover/abc123')).toBe(
      false,
    );
  });
});

// The pure predicate above can't express the bug that actually shipped: the
// one-shot guard was armed correctly and then silently DISARMED by the next
// successful response, so `alreadyTried` was false again on every reload and the
// tab ping-ponged between `/` and `/login?next=/` until the auth rate limiter
// answered 429. That lifecycle only shows up through `api()` itself.
function respond(status: number) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: () => Promise.resolve('{}'),
  });
}

// One logged-out page load of `/`, in App.vue's boot order: the public config
// endpoint answers 200 while the authed settings bootstrap answers 401.
async function bootLoggedOutAtRoot() {
  await api('/api/config').catch(() => {});
  await api('/api/settings/bootstrap').catch(() => {});
}

describe('stale-session bounce guard lifecycle', () => {
  let stored: Map<string, string>;
  let assigned: string[];
  let routes: Map<string, number>;

  beforeEach(() => {
    stored = new Map();
    assigned = [];
    routes = new Map([
      ['/api/config', 200],
      ['/api/settings/bootstrap', 401],
      ['/api/networks', 401],
    ]);
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, String(v)),
      removeItem: (k: string) => void stored.delete(k),
    });
    vi.stubGlobal('window', {
      location: { pathname: '/', assign: (url: string) => void assigned.push(url) },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => respond(routes.get(url) ?? 200)),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('bounces once, then stays put across the reload it triggered', async () => {
    await bootLoggedOutAtRoot();
    expect(assigned).toEqual(['/']);

    // The reload that bounce caused. Nothing about being logged out has changed,
    // so a second bounce here is the loop the user hit.
    await bootLoggedOutAtRoot();
    expect(assigned).toEqual(['/']);
  });

  it('does not re-arm on an unauthenticated 200 (the public /api/config hole)', async () => {
    await api('/api/networks').catch(() => {});
    expect(assigned).toEqual(['/']);

    await api('/api/config');
    await api('/api/networks').catch(() => {});
    expect(assigned).toEqual(['/']);
  });

  it('re-arms once a live session is proven, so a later loss still recovers', async () => {
    await bootLoggedOutAtRoot();
    expect(assigned).toEqual(['/']);

    // What the auth store does when /api/auth/me comes back with a user.
    clearAuthRecoveryGuard();

    await api('/api/networks').catch(() => {});
    expect(assigned).toEqual(['/', '/']);
  });
});
