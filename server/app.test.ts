// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
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
