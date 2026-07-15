// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { setupTestDb, createTestApp, testRequest } from '../test-utils/testApp.js';
import {
  FailureThrottle,
  RequestThrottle,
  LOGIN_FAILURE_MAX,
  resetAuthRateLimits,
} from './rateLimit.js';

// --- Unit: the throttle classes with an injected clock (the tricky edges) -----

describe('FailureThrottle', () => {
  const cfg = { windowMs: 1000, maxFailures: 3, backoffMs: 5000 };

  it('allows until the threshold, then blocks with a Retry-After', () => {
    let now = 0;
    const t = new FailureThrottle(cfg, () => now);
    expect(t.retryAfter('ip')).toBeNull();
    t.recordFailure('ip'); // 1
    t.recordFailure('ip'); // 2
    expect(t.retryAfter('ip')).toBeNull();
    t.recordFailure('ip'); // 3 -> trips
    const retry = t.retryAfter('ip');
    expect(retry).toBe(5); // 5000ms backoff -> 5s
  });

  it('auto-clears once the backoff elapses', () => {
    let now = 0;
    const t = new FailureThrottle(cfg, () => now);
    for (let i = 0; i < cfg.maxFailures; i++) t.recordFailure('ip');
    expect(t.retryAfter('ip')).not.toBeNull();
    now += cfg.backoffMs; // block horizon reached
    expect(t.retryAfter('ip')).toBeNull();
  });

  it('ages out failures older than the window (never trips on slow drips)', () => {
    let now = 0;
    const t = new FailureThrottle(cfg, () => now);
    t.recordFailure('ip'); // t=0
    now += 600;
    t.recordFailure('ip'); // t=600
    now += 600; // t=1200 — the first failure is now >windowMs old
    t.recordFailure('ip'); // only 2 live failures -> no trip
    expect(t.retryAfter('ip')).toBeNull();
  });

  it('a success (reset) wipes the slate', () => {
    let now = 0;
    const t = new FailureThrottle(cfg, () => now);
    t.recordFailure('ip');
    t.recordFailure('ip');
    t.reset('ip');
    t.recordFailure('ip'); // back to 1, not 3
    expect(t.retryAfter('ip')).toBeNull();
  });

  it('keys are independent', () => {
    let now = 0;
    const t = new FailureThrottle(cfg, () => now);
    for (let i = 0; i < cfg.maxFailures; i++) t.recordFailure('a');
    expect(t.retryAfter('a')).not.toBeNull();
    expect(t.retryAfter('b')).toBeNull();
  });
});

describe('RequestThrottle', () => {
  it('caps requests per window and reports Retry-After', () => {
    let now = 0;
    const t = new RequestThrottle({ windowMs: 1000, maxRequests: 2 }, () => now);
    expect(t.allow('ip').ok).toBe(true);
    expect(t.allow('ip').ok).toBe(true);
    const blocked = t.allow('ip') as { ok: false; retryAfter: number };
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBe(1);
    now += 1000; // window frees
    expect(t.allow('ip').ok).toBe(true);
  });
});

// --- Integration: the wired auth endpoints -----------------------------------

const ctx = setupTestDb('middleware-ratelimit');

let app: Express;

beforeAll(async () => {
  const router = (await import('../routes/auth.js')).default;
  app = createTestApp({ '/api/auth': router });
  // First admin with a known password, so we can drive real failed logins.
  await testRequest(app)
    .post('/api/auth/setup/password')
    .send({ username: 'admin', password: 'correct-horse' });
});

afterAll(() => ctx.cleanup());

beforeEach(() => resetAuthRateLimits());

describe('POST /api/auth/login/password rate limiting', () => {
  it('backs off with 429 + Retry-After after repeated failures', async () => {
    for (let i = 0; i < LOGIN_FAILURE_MAX; i++) {
      const r = await testRequest(app)
        .post('/api/auth/login/password')
        .send({ username: 'admin', password: 'wrong' });
      expect(r.status).toBe(401);
    }
    const blocked = await testRequest(app)
      .post('/api/auth/login/password')
      .send({ username: 'admin', password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('does not throttle a correct login, and a success clears the slate', async () => {
    // A few failures, then a success — which resets the counter...
    for (let i = 0; i < LOGIN_FAILURE_MAX - 1; i++) {
      await testRequest(app)
        .post('/api/auth/login/password')
        .send({ username: 'admin', password: 'wrong' });
    }
    const ok = await testRequest(app)
      .post('/api/auth/login/password')
      .send({ username: 'admin', password: 'correct-horse' });
    expect(ok.status).toBe(200);
    // ...so the next failure starts from zero rather than immediately tripping.
    const after = await testRequest(app)
      .post('/api/auth/login/password')
      .send({ username: 'admin', password: 'wrong' });
    expect(after.status).toBe(401);
  });

  it('keys per client IP so one attacker cannot lock out another user', async () => {
    // Standalone honors X-Forwarded-For only under LURKER_TRUST_PROXY — opt in so
    // the two simulated clients get distinct keys instead of sharing 127.0.0.1.
    const prevTrustProxy = process.env.LURKER_TRUST_PROXY;
    process.env.LURKER_TRUST_PROXY = 'true';
    try {
      for (let i = 0; i < LOGIN_FAILURE_MAX; i++) {
        await testRequest(app)
          .post('/api/auth/login/password')
          .set('X-Forwarded-For', '10.0.0.1')
          .send({ username: 'admin', password: 'wrong' });
      }
      const attacker = await testRequest(app)
        .post('/api/auth/login/password')
        .set('X-Forwarded-For', '10.0.0.1')
        .send({ username: 'admin', password: 'wrong' });
      expect(attacker.status).toBe(429);
      // A different IP is unaffected.
      const other = await testRequest(app)
        .post('/api/auth/login/password')
        .set('X-Forwarded-For', '10.0.0.2')
        .send({ username: 'admin', password: 'wrong' });
      expect(other.status).toBe(401);
    } finally {
      if (prevTrustProxy === undefined) delete process.env.LURKER_TRUST_PROXY;
      else process.env.LURKER_TRUST_PROXY = prevTrustProxy;
    }
  });
});
