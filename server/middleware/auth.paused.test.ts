// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// #573: the paused-account write block lives centrally in requireAuth, so EVERY
// authed router inherits it — not just networks + dcc (which used to mount it
// explicitly). This proves the previously-unguarded routers (settings, push,
// api-tokens, uploads, exports) now reject writes from a paused account while
// still serving reads.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

const ctx = setupTestDb('middleware-paused');

let app: Express;
let agent: LurkerTestAgent;
let userId: number;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const settingsRouter = (await import('../routes/settings.js')).default;
  const pushRouter = (await import('../routes/push.js')).default;
  const apiTokensRouter = (await import('../routes/apiTokens.js')).default;
  const uploadsRouter = (await import('../routes/uploads.js')).default;
  const { exportsRouter } = await import('../routes/exports.js');

  const user = createUser('paused-central');
  userId = user.id;
  app = createTestApp({
    '/api/settings': settingsRouter,
    '/api/push': pushRouter,
    '/api/api-tokens': apiTokensRouter,
    '/api/uploads': uploadsRouter,
    '/api/exports': exportsRouter,
  });
  agent = await createAuthedAgent(app, user.id);
});

afterAll(() => ctx.cleanup());

// Each entry is a mutating request that used to slip past the pause block
// because its router never mounted blockWritesWhenPaused. The 403 now fires in
// requireAuth BEFORE the route handler runs, so the request bodies are
// irrelevant (an empty body still gets the pause 403, never a validation error).
const WRITES: Array<[string, string]> = [
  ['patch', '/api/settings/'],
  ['delete', '/api/settings/some-key'],
  ['post', '/api/push/subscriptions'],
  ['delete', '/api/push/subscriptions'],
  ['post', '/api/api-tokens/'],
  ['delete', '/api/api-tokens/1'],
  ['post', '/api/uploads'],
  ['post', '/api/exports/'],
];

// Reads must still work for a paused account so the UI renders read-only.
const READS: string[] = ['/api/settings/bootstrap', '/api/api-tokens/', '/api/push/subscriptions'];

describe('paused accounts are read-only across every authed router (#573)', () => {
  it('serves reads with 200 both while active and while paused', async () => {
    const { setUserPaused } = await import('../db/users.js');
    // Active: reads work normally.
    setUserPaused(userId, false);
    for (const path of READS) {
      const res = await agent.get(path);
      expect(res.status, `GET ${path} should be 200 while active`).toBe(200);
    }
    // Paused: the same reads still return 200 (only writes are blocked).
    setUserPaused(userId, true);
    for (const path of READS) {
      const res = await agent.get(path);
      expect(res.status, `GET ${path} should still be 200 while paused`).toBe(200);
    }
    setUserPaused(userId, false);
  });

  it('blocks every write with a clean 403 while paused', async () => {
    const { setUserPaused } = await import('../db/users.js');
    setUserPaused(userId, true);
    for (const [method, path] of WRITES) {
      const res = await (method === 'patch'
        ? agent.patch(path)
        : method === 'delete'
          ? agent.delete(path)
          : agent.post(path));
      expect(res.status, `${method.toUpperCase()} ${path} should be blocked while paused`).toBe(
        403,
      );
      expect(res.body.error).toBe('account paused');
    }
    setUserPaused(userId, false);
  });

  it('restores write access once un-paused', async () => {
    const { setUserPaused } = await import('../db/users.js');
    // While paused the write is blocked...
    setUserPaused(userId, true);
    const blocked = await agent.patch('/api/settings').send({ changes: { 'look.font.size': 18 } });
    expect(blocked.status).toBe(403);
    // ...and once un-paused the same valid write actually lands (200), proving
    // the gate released rather than merely stopped returning the pause 403.
    setUserPaused(userId, false);
    const ok = await agent.patch('/api/settings').send({ changes: { 'look.font.size': 18 } });
    expect(ok.status).toBe(200);
    expect(ok.body.values['look.font.size']).toBe(18);
  });
});
