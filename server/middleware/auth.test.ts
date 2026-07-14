// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Router } from 'express';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  testRequest,
  type TestDbContext,
} from '../test-utils/testApp.js';

const ctx: TestDbContext = setupTestDb('auth-mw');

let app: Express;
let userId: number;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { requireAuth } = await import('./auth.js');
  userId = createUser('alice').id;
  const router = Router();
  router.get('/', requireAuth, (_req, res) => {
    res.json({ ok: true });
  });
  app = createTestApp({ '/protected': router });
});

afterAll(() => ctx.cleanup());

// clearCookie emits the cookie with an expiry in the past; the value is a signed
// empty string (getCookieOptions has signed:true), so match on name + past Expires.
const clears = (setCookie: string[] | undefined, name: string): boolean =>
  (setCookie ?? []).some((c) => c.startsWith(`${name}=`) && /Expires=Thu, 01 Jan 1970/i.test(c));

describe('requireAuth stale-session recovery', () => {
  it('lets a valid session through', async () => {
    const agent = await createAuthedAgent(app, userId);
    const res = await agent.get('/protected');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('clears BOTH lurker_session and cp_session on a stale (bad-signature) cookie', async () => {
    // A cookie signed with a different secret — what a rebuilt cell with a fresh
    // SESSION_SECRET sees from a browser holding the old lurker_session.
    const res = await testRequest(app)
      .get('/protected')
      .set('Cookie', 'lurker_session=s%3Astale.deadbeefbadsignature');
    expect(res.status).toBe(401);
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(clears(setCookie, 'lurker_session')).toBe(true);
    expect(clears(setCookie, 'cp_session')).toBe(true);
  });

  it('does not clear cookies when no session cookie was sent', async () => {
    const res = await testRequest(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

// Native clients (iOS/Android) present the session token as a bearer instead of
// a cookie. Same session row, same lookup — the only difference is where the
// token rides on the request.
describe('requireAuth bearer auth (native clients)', () => {
  it('accepts a session token presented as a bearer', async () => {
    const { createSession } = await import('../db/sessions.js');
    const { token } = createSession(userId);
    const res = await testRequest(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects an unknown bearer token without clearing cookies', async () => {
    const res = await testRequest(app).get('/protected').set('Authorization', 'Bearer nonsense');
    expect(res.status).toBe(401);
    // No cookie was sent, so there is no stale cookie to clear — a native client
    // has no cookie jar and must not be handed Set-Cookie headers.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await testRequest(app).get('/protected').set('Authorization', 'Basic abc123');
    expect(res.status).toBe(401);
  });

  it('rejects a bearer whose session has expired', async () => {
    const { createSession } = await import('../db/sessions.js');
    const db = (await import('../db/index.js')).default;
    const { token } = createSession(userId);
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      token,
    );
    const res = await testRequest(app).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('falls through to the bearer when the cookie is stale', async () => {
    // Not a shape a real native client produces (it sends no cookie at all), but
    // it pins the precedence: a dead cookie must not shadow a good bearer.
    const { createSession } = await import('../db/sessions.js');
    const { token } = createSession(userId);
    const res = await testRequest(app)
      .get('/protected')
      .set('Cookie', 'lurker_session=s%3Astale.deadbeefbadsignature')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
