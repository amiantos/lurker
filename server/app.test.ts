// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { setupTestDb, testRequest, TEST_SESSION_SECRET } from './test-utils/testApp.js';

// buildApp gates routes on the cached edition, resolved once per module
// instance. vi.resetModules() between builds hands each call a fresh edition
// module that re-reads LURKER_EDITION, so both editions can be exercised in one
// process — letting us assert the gating is two-sided (off in node, on in
// standalone) rather than just that a route happens to be missing.
const ctx = setupTestDb('app-gating');

afterAll(() => ctx.cleanup());
afterEach(() => {
  delete process.env.LURKER_EDITION;
});

async function buildFor(edition: 'standalone' | 'node'): Promise<Express> {
  vi.resetModules();
  process.env.LURKER_EDITION = edition;
  const { buildApp } = await import('./app.js');
  return buildApp(TEST_SESSION_SECRET);
}

describe('buildApp route gating by edition', () => {
  describe('node edition', () => {
    it('does not mount /api/api-tokens', async () => {
      const app = await buildFor('node');
      // 404 (no route), distinct from the 401 a mounted-but-authless route gives.
      const res = await testRequest(app).get('/api/api-tokens');
      expect(res.status).toBe(404);
    });

    it('does not mount the MCP server at /mcp', async () => {
      const app = await buildFor('node');
      const res = await testRequest(app)
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(res.status).toBe(404);
    });

    it('404s GET /mcp too (not swallowed by the SPA fallback)', async () => {
      const app = await buildFor('node');
      // `mcp` is excluded from the SPA catch-all, so a disabled /mcp is
      // consistently absent rather than served index.html.
      const res = await testRequest(app).get('/mcp');
      expect(res.status).toBe(404);
    });

    it('mounts the orchestrator control surface /api/node', async () => {
      const app = await buildFor('node');
      // requireNodeAuth rejects (503 with no secret configured), but the router
      // IS mounted — the point is it does not 404.
      const res = await testRequest(app).get('/api/node/status');
      expect(res.status).not.toBe(404);
    });
  });

  describe('SPA fallback', () => {
    it('404s a missing /assets file instead of serving index.html (#571)', async () => {
      const app = await buildFor('standalone');
      // A stale client asking for a hashed chunk that no longer exists must get
      // a plain 404. Answering with index.html (200, text/html) turns a dead
      // lazy route into a confusing module-type refusal the client can't
      // classify — and the failed import is then memoized forever.
      const res = await testRequest(app).get('/assets/Settings-deadbeef.js');
      expect(res.status).toBe(404);
      // Express's own 404 page is HTML, so content-type proves nothing here —
      // what matters is that the body is not the SPA shell being passed off as
      // a JS module.
      expect(res.text ?? '').not.toContain('id="app"');
    });

    // Asserting the client route still works needs a built client, and CI runs
    // the suite without one (.github/workflows/test.yml never builds vue_client).
    // Skipping when dist/ is absent is honest; the alternative — accepting a 404
    // as a pass so the test runs everywhere — passed even when the fallback was
    // broken outright, which is worse than no test because it reads as coverage.
    const hasBuiltClient = existsSync(
      path.join(import.meta.dirname, '../vue_client/dist/index.html'),
    );

    it.skipIf(!hasBuiltClient)('still serves index.html for a real client route', async () => {
      const app = await buildFor('standalone');
      const res = await testRequest(app).get('/settings');
      // Strict: /settings must reach the catch-all and get the SPA shell, not
      // merely fail to be a hard 404.
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('id="app"');
    });

    it.skipIf(!hasBuiltClient)(
      '404s a /.well-known URL nothing serves, rather than handing back the SPA',
      async () => {
        // A client probing for a discovery document (an MCP client asking for OAuth
        // protected-resource metadata, #891) needs a 404 it can act on; the SPA's
        // HTML with a 200 reads as a broken document instead.
        const app = await buildFor('standalone');
        const res = await testRequest(app).get('/.well-known/oauth-protected-resource/mcp');
        expect(res.status).toBe(404);
        expect(res.text ?? '').not.toContain('id="app"');
      },
    );

    it.skipIf(!hasBuiltClient)(
      'serves the OAuth approval page with headers that forbid framing it (#891)',
      async () => {
        const app = await buildFor('standalone');
        // Every spelling the client router renders the page for, not just the canonical one.
        for (const spelling of ['/oauth/authorize', '/oauth/authorize/', '/OAuth/Authorize']) {
          const res = await testRequest(app).get(`${spelling}?client_id=x`);
          expect(res.status).toBe(200);
          expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
          expect(res.headers['x-frame-options']).toBe('DENY');
          expect(res.headers['cache-control']).toBe('no-store');
          expect(res.headers['referrer-policy']).toBe('no-referrer');
        }
        // …and only there: the rest of the app stays embeddable.
        const settings = await testRequest(app).get('/settings');
        expect(settings.headers['x-frame-options']).toBeUndefined();
      },
    );
  });

  describe('standalone edition', () => {
    it('mounts /api/api-tokens (requireAuth → 401, not 404)', async () => {
      const app = await buildFor('standalone');
      const res = await testRequest(app).get('/api/api-tokens');
      expect(res.status).toBe(401);
    });

    it('mounts the MCP server (requireApiAuth → 401 without a bearer token)', async () => {
      const app = await buildFor('standalone');
      const res = await testRequest(app)
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(res.status).toBe(401);
    });

    it('does not mount the orchestrator control surface /api/node', async () => {
      const app = await buildFor('standalone');
      const res = await testRequest(app).get('/api/node/status');
      expect(res.status).toBe(404);
    });
  });
});

describe('OAuth (#891) mounting', () => {
  it('is mounted in standalone: registration answers rather than 404ing', async () => {
    const app = await buildFor('standalone');
    const res = await testRequest(app).post('/api/oauth/register').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('is not mounted in node edition, where sign-in happens in front of the cell', async () => {
    const app = await buildFor('node');
    expect((await testRequest(app).post('/api/oauth/register').send({})).status).toBe(404);
    expect((await testRequest(app).get('/api/oauth/apps')).status).toBe(404);
    const discovery = await testRequest(app).get('/.well-known/oauth-authorization-server');
    expect(discovery.headers['content-type'] ?? '').not.toMatch(/json/);
  });

  it('serves the discovery document as JSON, ahead of the SPA fallback', async () => {
    const app = await buildFor('standalone');
    const saved = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      const res = await testRequest(app)
        .get('/.well-known/oauth-authorization-server')
        .set('Host', 'irc.example.com');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        issuer: 'http://irc.example.com',
        authorization_endpoint: 'http://irc.example.com/oauth/authorize',
        registration_endpoint: 'http://irc.example.com/api/oauth/register',
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
    } finally {
      if (saved !== undefined) process.env.PUBLIC_BASE_URL = saved;
    }
  });
});

describe('request body errors', () => {
  it('answers a malformed body with 400 and never logs it', async () => {
    // The parser attaches the raw body to its error, and that body can hold a
    // password or an OAuth code verifier.
    const app = await buildFor('standalone');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await testRequest(app)
        .post('/api/oauth/token')
        .set('Content-Type', 'application/json')
        .send('{"code_verifier":"do-not-log-me"');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request' });
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
