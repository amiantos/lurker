// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { shouldBounceToLogin } from './api.js';

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
  });
});
