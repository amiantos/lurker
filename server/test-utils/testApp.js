// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

// Shared helpers for route integration tests. The pattern is:
//
//   import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
//   setupTestDb();
//   let app, agent, user;
//   beforeAll(async () => {
//     const { createUser } = await import('../db/users.js');
//     const fooRouter = (await import('../routes/foo.js')).default;
//     user = createUser('alice');
//     app = createTestApp({ '/api/foo': fooRouter });
//     agent = await createAuthedAgent(app, user.id);
//   });
//
// setupTestDb MUST run at module top level (not inside beforeAll) so the
// DATABASE_PATH env var is set before any dynamic import touches db/index.js.

import express from 'express';
import cookieParser from 'cookie-parser';
import { sign as signCookie } from 'cookie-signature';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const TEST_SESSION_SECRET = 'test-session-secret';

// Each test file gets its own temp dir + DB file. Caller can override the
// suffix to keep parallel test files from colliding (vitest runs files in
// parallel by default, and each one is a separate process — collisions are
// rare but the suffix makes the intent explicit).
export function setupTestDb(suffix = '') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `lurker-test${suffix ? '-' + suffix : ''}-`));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  // Required by middleware/auth.js getCookieOptions (signed cookies).
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  return {
    tmpDir,
    dbPath: process.env.DATABASE_PATH,
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// Build a minimal Express app that mirrors how server.js wires up middleware:
// JSON body parsing, cookie-parser keyed to the test session secret, and the
// requested router(s) mounted at their paths. routerMounts is { '/path':
// router } or a single router with mountPath; arrays are supported for multi-
// router apps (e.g. exports + imports).
export function createTestApp(routerMounts) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(TEST_SESSION_SECRET));
  if (routerMounts && typeof routerMounts === 'object') {
    for (const [mount, router] of Object.entries(routerMounts)) {
      app.use(mount, router);
    }
  }
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message || 'internal error' });
  });
  return app;
}

// Returns a supertest agent pre-loaded with a signed lurker_session cookie for
// the given user. Creates a real session row via db/sessions.js — the route
// handlers then go through the unmodified loadSession path.
export async function createAuthedAgent(app, userId) {
  const { createSession } = await import('../db/sessions.js');
  const { token } = createSession(userId);
  const signed = 's:' + signCookie(token, TEST_SESSION_SECRET);
  const agent = request.agent(app);
  // request.agent stores cookies by jar, but the simplest reliable approach is
  // to set the Cookie header on every request. Supertest's .set('Cookie',...)
  // sticks for the agent's lifetime.
  agent.set('Cookie', `lurker_session=${encodeURIComponent(signed)}`);
  return agent;
}

// Convenience: build an unauthenticated supertest agent against the app.
export function createAnonAgent(app) {
  return request.agent(app);
}
