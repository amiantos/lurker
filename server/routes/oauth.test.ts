// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// End-to-end cover for OAuth sign-in (#891): a third-party app registers, the
// member approves it with their browser session, the app exchanges the code, and
// the token signs in exactly like a password session until it's revoked. The
// routers are mounted together so the loop runs the way it does in production.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  testRequest,
} from '../test-utils/testApp.js';
import type { LurkerTestAgent } from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-oauth');

const OOB = 'urn:ietf:wg:oauth:2.0:oob';
const APP_REDIRECT = 'com.example.testclient:/oauth';
const LOOPBACK = 'http://127.0.0.1:8000/callback';

let app: Express;
let db: typeof import('../db/index.js').default;
let createUser: typeof import('../db/users.js').createUser;
let createSession: typeof import('../db/sessions.js').createSession;
let oauthDb: typeof import('../db/oauth.js');
let routes: typeof import('./oauth.js');
let resetAuthRateLimits: typeof import('../middleware/rateLimit.js').resetAuthRateLimits;

beforeAll(async () => {
  db = (await import('../db/index.js')).default;
  ({ createUser } = await import('../db/users.js'));
  ({ createSession } = await import('../db/sessions.js'));
  ({ resetAuthRateLimits } = await import('../middleware/rateLimit.js'));
  oauthDb = await import('../db/oauth.js');
  routes = await import('./oauth.js');
  const authRouter = (await import('./auth.js')).default;
  const apiTokensRouter = (await import('./apiTokens.js')).default;
  const pushRouter = (await import('./push.js')).default;
  app = createTestApp({
    '/api/oauth': routes.oauthRouter,
    '/api/auth': authRouter,
    '/api/api-tokens': apiTokensRouter,
    '/api/push': pushRouter,
  });
});

afterAll(() => ctx.cleanup());

beforeEach(() => {
  routes.registrationThrottle.clear();
  resetAuthRateLimits();
});

interface Flow {
  clientId: string;
  redirectUri: string;
  verifier: string;
  challenge: string;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(
  redirectUris: string[] = [OOB],
  extra: Record<string, unknown> = {},
): Promise<{ client_id: string }> {
  const res = await testRequest(app)
    .post('/api/oauth/register')
    .send({ client_name: 'Test Client', redirect_uris: redirectUris, ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

async function startFlow(redirectUri = OOB): Promise<Flow> {
  const { client_id } = await register([redirectUri]);
  return { clientId: client_id, redirectUri, ...pkce() };
}

function authorizeParams(flow: Flow, extra: Record<string, string> = {}): Record<string, string> {
  return {
    client_id: flow.clientId,
    redirect_uri: flow.redirectUri,
    response_type: 'code',
    code_challenge: flow.challenge,
    code_challenge_method: 'S256',
    state: 'st4te',
    ...extra,
  };
}

// Approve as `member` and return the code, from the body for out-of-band or from
// the redirect otherwise.
async function approve(member: LurkerTestAgent, flow: Flow): Promise<string> {
  const res = await member
    .post('/api/oauth/authorize')
    .send({ ...authorizeParams(flow), decision: 'approve' });
  expect(res.status).toBe(200);
  if (res.body.code) return res.body.code;
  return new URL(res.body.redirect).searchParams.get('code') ?? '';
}

function exchange(flow: Flow, code: string, overrides: Record<string, string> = {}) {
  return testRequest(app)
    .post('/api/oauth/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      client_id: flow.clientId,
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
      ...overrides,
    });
}

// The whole dance for a fresh app: the member approves it and the app gets a token.
async function tokenFor(userId: number): Promise<{ token: string; flow: Flow }> {
  const member = await createAuthedAgent(app, userId);
  const flow = await startFlow();
  const res = await exchange(flow, await approve(member, flow));
  expect(res.status).toBe(200);
  return { token: res.body.access_token, flow };
}

function asApp(token: string) {
  return {
    get: (path: string) => testRequest(app).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string) => testRequest(app).post(path).set('Authorization', `Bearer ${token}`),
  };
}

describe('POST /api/oauth/register', () => {
  it('registers a public client and says so', async () => {
    const res = await testRequest(app)
      .post('/api/oauth/register')
      .send({
        client_name: 'Spooky',
        redirect_uris: [APP_REDIRECT],
        client_uri: 'https://spooky.example',
        token_endpoint_auth_method: 'client_secret_basic',
        scope: 'read',
      });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toMatchObject({
      client_name: 'Spooky',
      client_uri: 'https://spooky.example',
      redirect_uris: [APP_REDIRECT],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(res.body.client_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body).not.toHaveProperty('client_secret');
  });

  it('refuses an unsupported redirect URI', async () => {
    const res = await testRequest(app)
      .post('/api/oauth/register')
      .send({ client_name: 'Bad', redirect_uris: ['javascript:alert(1)'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
  });

  it('allows five registrations per address every ten minutes', async () => {
    for (let i = 0; i < 5; i++) await register();
    const res = await testRequest(app)
      .post('/api/oauth/register')
      .send({ client_name: 'Sixth', redirect_uris: [OOB] });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('stops accepting registrations while too many wait for approval', async () => {
    const room = oauthDb.MAX_PENDING_APPS - oauthDb.countPendingApps();
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO oauth_apps (client_id, client_name, redirect_uris)
       SELECT 'pending-filler-' || i, 'Filler', '[]' FROM n`,
    ).run(room);
    try {
      const res = await testRequest(app)
        .post('/api/oauth/register')
        .send({ client_name: 'One too many', redirect_uris: [OOB] });
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('temporarily_unavailable');
    } finally {
      db.prepare(`DELETE FROM oauth_apps WHERE client_id LIKE 'pending-filler-%'`).run();
    }
  });
});

describe('GET /api/oauth/authorize', () => {
  let member: LurkerTestAgent;

  beforeAll(async () => {
    member = await createAuthedAgent(app, createUser('oauth-authorize-get').id);
  });

  it('describes the app and where the approval goes', async () => {
    const { client_id } = await register([APP_REDIRECT], {
      client_uri: 'https://client.example/about',
    });
    const flow = { clientId: client_id, redirectUri: APP_REDIRECT, ...pkce() };
    const res = await member.get('/api/oauth/authorize').query(authorizeParams(flow));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toEqual({
      app: { name: 'Test Client', website: 'client.example' },
      destination: { kind: 'app', scheme: 'com.example.testclient' },
    });
  });

  it('accepts a loopback redirect on a port other than the registered one', async () => {
    const flow = await startFlow(LOOPBACK);
    const res = await member
      .get('/api/oauth/authorize')
      .query(authorizeParams({ ...flow, redirectUri: 'http://127.0.0.1:61234/callback' }));
    expect(res.status).toBe(200);
    expect(res.body.destination).toEqual({ kind: 'loopback' });
  });

  it('reports a bad redirect as an error, never as a redirect', async () => {
    const flow = await startFlow(APP_REDIRECT);
    const res = await member
      .get('/api/oauth/authorize')
      .query(authorizeParams({ ...flow, redirectUri: 'com.example.attacker:/steal' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
    expect(res.body).not.toHaveProperty('redirect');
  });

  it.each([
    ['an unknown client', { client_id: 'no-such-client' }, 'invalid_client'],
    ['no PKCE method', { code_challenge_method: '' }, 'invalid_request'],
    ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['response_type=token', { response_type: 'token' }, 'unsupported_response_type'],
  ])('refuses %s', async (_label, override, error) => {
    const flow = await startFlow();
    const res = await member.get('/api/oauth/authorize').query(authorizeParams(flow, override));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
  });

  it('needs a signed-in member', async () => {
    const flow = await startFlow();
    const res = await testRequest(app).get('/api/oauth/authorize').query(authorizeParams(flow));
    expect(res.status).toBe(401);
  });

  it('takes only the browser session cookie, not a bearer session', async () => {
    // Otherwise a password-login client could approve apps for itself, with no page.
    const { token } = createSession(createUser('oauth-authorize-bearer').id);
    const flow = await startFlow();
    const res = await testRequest(app)
      .get('/api/oauth/authorize')
      .query(authorizeParams(flow))
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/oauth/authorize', () => {
  let member: LurkerTestAgent;

  beforeAll(async () => {
    member = await createAuthedAgent(app, createUser('oauth-authorize-post').id);
  });

  it('returns the code itself for an out-of-band redirect', async () => {
    const flow = await startFlow(OOB);
    const res = await member
      .post('/api/oauth/authorize')
      .send({ ...authorizeParams(flow), decision: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body).not.toHaveProperty('redirect');
  });

  it('redirects to an app with the code and state', async () => {
    const flow = await startFlow(APP_REDIRECT);
    const res = await member
      .post('/api/oauth/authorize')
      .send({ ...authorizeParams(flow), decision: 'approve' });
    const url = new URL(res.body.redirect);
    expect(`${url.protocol}${url.pathname}`).toBe(APP_REDIRECT);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('st4te');
  });

  it('redirects to the loopback port the app asked for', async () => {
    const flow = await startFlow(LOOPBACK);
    const res = await member.post('/api/oauth/authorize').send({
      ...authorizeParams({ ...flow, redirectUri: 'http://127.0.0.1:61234/callback' }),
      decision: 'approve',
    });
    expect(new URL(res.body.redirect).port).toBe('61234');
  });

  it('sends a denial back as access_denied', async () => {
    const flow = await startFlow(APP_REDIRECT);
    const res = await member
      .post('/api/oauth/authorize')
      .send({ ...authorizeParams(flow), decision: 'deny' });
    const url = new URL(res.body.redirect);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.has('code')).toBe(false);
  });

  it('answers an out-of-band denial without a redirect', async () => {
    const flow = await startFlow(OOB);
    const res = await member
      .post('/api/oauth/authorize')
      .send({ ...authorizeParams(flow), decision: 'deny' });
    expect(res.body).toEqual({ denied: true });
  });

  it('refuses a form post, which a cross-site page could send', async () => {
    const flow = await startFlow();
    const res = await member
      .post('/api/oauth/authorize')
      .type('form')
      .send({ ...authorizeParams(flow), decision: 'approve' });
    expect(res.status).toBe(415);
  });

  it('refuses a missing decision', async () => {
    const flow = await startFlow();
    const res = await member.post('/api/oauth/authorize').send(authorizeParams(flow));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/oauth/token', () => {
  let member: LurkerTestAgent;

  beforeAll(async () => {
    member = await createAuthedAgent(app, createUser('oauth-token').id);
  });

  it('exchanges a code for a token that never expires', async () => {
    const flow = await startFlow();
    const res = await exchange(flow, await approve(member, flow));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body).not.toHaveProperty('expires_in');
    expect(res.body).not.toHaveProperty('refresh_token');
  });

  it('accepts a JSON body as well as a form', async () => {
    const flow = await startFlow();
    const code = await approve(member, flow);
    const res = await testRequest(app).post('/api/oauth/token').send({
      grant_type: 'authorization_code',
      client_id: flow.clientId,
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
    expect(res.status).toBe(200);
  });

  it('spends a code once', async () => {
    const flow = await startFlow();
    const code = await approve(member, flow);
    expect((await exchange(flow, code)).status).toBe(200);
    const again = await exchange(flow, code);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it.each([
    ['the wrong verifier', () => ({ code_verifier: pkce().verifier })],
    ['a different redirect_uri', () => ({ redirect_uri: 'com.example.other:/oauth' })],
  ])('refuses %s, and the code is spent anyway', async (_label, override) => {
    const flow = await startFlow();
    const code = await approve(member, flow);
    const bad = await exchange(flow, code, override());
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_grant');
    // Someone it wasn't issued to has seen it, so the right request can't use it now.
    expect((await exchange(flow, code)).status).toBe(400);
  });

  it('refuses a code issued to another app, and burns it', async () => {
    const mine = await startFlow();
    const code = await approve(member, mine);
    const other = await startFlow();
    const res = await exchange({ ...other, verifier: mine.verifier }, code);
    expect(res.body.error).toBe('invalid_grant');
    expect((await exchange(mine, code)).status).toBe(400);
  });

  it('refuses an unknown client without burning the code', async () => {
    const flow = await startFlow();
    const code = await approve(member, flow);
    const res = await exchange({ ...flow, clientId: 'no-such-client' }, code);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect((await exchange(flow, code)).status).toBe(200);
  });

  it('refuses an expired code', async () => {
    const flow = await startFlow();
    const code = await approve(member, flow);
    db.prepare(
      `UPDATE oauth_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code_hash = ?`,
    ).run(oauthDb.hashSecret(code));
    const res = await exchange(flow, code);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refuses other grant types', async () => {
    const res = await testRequest(app)
      .post('/api/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: 'anything' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it('refuses a parameter sent twice', async () => {
    const flow = await startFlow();
    const code = await approve(member, flow);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: flow.clientId,
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
    body.append('code', code);
    const res = await testRequest(app).post('/api/oauth/token').type('form').send(body.toString());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});

describe('an OAuth access token', () => {
  it('signs in like a session', async () => {
    const user = createUser('oauth-token-signs-in');
    const { token } = await tokenFor(user.id);
    const me = await asApp(token).get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
  });

  it('reaches the same routes a password sign-in does', async () => {
    const user = createUser('oauth-token-parity');
    const { token } = await tokenFor(user.id);
    const created = await asApp(token)
      .post('/api/api-tokens')
      .send({ name: 'made by an app', scope: 'read' });
    expect(created.status).toBe(201);
    const listed = await asApp(token).get('/api/api-tokens');
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
  });

  it('is read-only while the account is paused, like a session', async () => {
    const user = createUser('oauth-token-paused');
    const { token } = await tokenFor(user.id);
    db.prepare('UPDATE users SET is_paused = 1 WHERE id = ?').run(user.id);
    const res = await asApp(token).post('/api/api-tokens').send({ name: 'x', scope: 'read' });
    expect(res.status).toBe(403);
  });

  it('stops working once the app signs out with it', async () => {
    const user = createUser('oauth-token-logout');
    const { token } = await tokenFor(user.id);
    expect((await asApp(token).post('/api/auth/logout')).status).toBe(200);
    expect((await asApp(token).get('/api/auth/me')).status).toBe(401);
  });
});

describe('POST /api/oauth/revoke', () => {
  it('revokes a token for the client it was issued to', async () => {
    const user = createUser('oauth-revoke');
    const { token, flow } = await tokenFor(user.id);
    const res = await testRequest(app)
      .post('/api/oauth/revoke')
      .type('form')
      .send({ client_id: flow.clientId, token });
    expect(res.status).toBe(200);
    expect((await asApp(token).get('/api/auth/me')).status).toBe(401);
  });

  it('answers 200 for a token that never existed, so it cannot probe', async () => {
    const flow = await startFlow();
    const res = await testRequest(app)
      .post('/api/oauth/revoke')
      .type('form')
      .send({ client_id: flow.clientId, token: 'no-such-token' });
    expect(res.status).toBe(200);
  });

  it('leaves a token alone when a different client asks', async () => {
    const user = createUser('oauth-revoke-other-client');
    const { token } = await tokenFor(user.id);
    const other = await startFlow();
    await testRequest(app)
      .post('/api/oauth/revoke')
      .type('form')
      .send({ client_id: other.clientId, token });
    expect((await asApp(token).get('/api/auth/me')).status).toBe(200);
  });

  it('deletes the push subscriptions the app registered, and only those', async () => {
    const user = createUser('oauth-revoke-push');
    const { token, flow } = await tokenFor(user.id);
    const browser = await createAuthedAgent(app, user.id);
    const keys = { p256dh: 'key', auth: 'auth' };
    const byApp = await asApp(token)
      .post('/api/push/subscriptions')
      .send({ endpoint: 'https://push.example/app', keys });
    expect(byApp.status).toBe(201);
    const byBrowser = await browser
      .post('/api/push/subscriptions')
      .send({ endpoint: 'https://push.example/browser', keys });
    expect(byBrowser.status).toBe(201);

    await testRequest(app)
      .post('/api/oauth/revoke')
      .type('form')
      .send({ client_id: flow.clientId, token });

    const push = await import('../db/pushSubscriptions.js');
    expect(push.listAllForUser(user.id).map((s) => s.endpoint)).toEqual([
      'https://push.example/browser',
    ]);
  });
});

describe('authorized apps', () => {
  it('lists the apps a member authorized, and revokes one', async () => {
    const user = createUser('oauth-apps');
    const member = await createAuthedAgent(app, user.id);
    const { token } = await tokenFor(user.id);

    const list = await member.get('/api/oauth/apps');
    expect(list.status).toBe(200);
    expect(list.body.apps).toHaveLength(1);
    expect(list.body.apps[0]).toMatchObject({ name: 'Test Client' });

    const revoked = await member.delete(`/api/oauth/apps/${list.body.apps[0].id}`);
    expect(revoked.status).toBe(200);
    expect((await member.get('/api/oauth/apps')).body.apps).toEqual([]);
    expect((await asApp(token).get('/api/auth/me')).status).toBe(401);
  });

  it('404s for an app the member never authorized', async () => {
    const member = await createAuthedAgent(app, createUser('oauth-apps-404').id);
    const { flow } = await tokenFor(createUser('oauth-apps-someone-else').id);
    const appId = oauthDb.findAppByClientId(flow.clientId)?.id;
    expect((await member.delete(`/api/oauth/apps/${appId}`)).status).toBe(404);
  });
});
