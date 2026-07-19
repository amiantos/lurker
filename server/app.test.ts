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
