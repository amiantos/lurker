// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

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
import type { Express, Router, ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { sign as signCookie } from 'cookie-signature';
import request from 'supertest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

export const TEST_SESSION_SECRET = 'test-session-secret';

// One listening server per app, reused by every agent and every request.
//
// Handed a bare Express app, supertest binds a fresh ephemeral port with
// listen(0) for EACH request and close()s it once the response lands. Across a
// full suite run that churns thousands of short-lived listeners, and a small
// fraction of those connections get reset by the kernel — surfacing as a
// "socket hang up" that fails whichever route test happened to be running.
// It's rare, load-dependent, and lands on an arbitrary test, which is exactly
// what makes it read as a flaky assertion rather than a transport fault.
//
// Handing supertest an ALREADY-LISTENING server instead makes it skip both the
// listen and the close (see supertest's Test#serverAddress / Test#end), so the
// whole file shares one stable port. listen() binds synchronously, so
// address() is live by the time an agent issues its first request.
const servers = new WeakMap<Express, http.Server>();
let openServers: http.Server[] = [];

function listeningServer(app: Express): http.Server {
  const existing = servers.get(app);
  if (existing) return existing;
  const server = http.createServer(app);
  // No host argument: listen(0) binds synchronously, so address() is live on
  // return. Passing a host defers the bind to a DNS/next-tick path, address()
  // stays null, and supertest would silently go right back to listening per
  // request.
  server.listen(0);
  // If address() is ever null here, supertest quietly falls back to listening
  // per request and the flake comes back unnoticed — fail loudly instead.
  if (!server.address()) {
    throw new Error('test server did not bind synchronously; supertest would listen per request');
  }
  // Never let a stray listener hold the vitest worker open.
  server.unref();
  servers.set(app, server);
  openServers.push(server);
  return server;
}

export interface TestDbContext {
  tmpDir: string;
  dbPath: string;
  cleanup(): void;
}

// Each test file gets its own temp dir + DB file. Caller can override the
// suffix to keep parallel test files from colliding (vitest runs files in
// parallel by default, and each one is a separate process — collisions are
// rare but the suffix makes the intent explicit).
export function setupTestDb(suffix = ''): TestDbContext {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `lurker-test${suffix ? '-' + suffix : ''}-`),
  );
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  // Required by middleware/auth.js getCookieOptions (signed cookies).
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  return {
    tmpDir,
    dbPath: process.env.DATABASE_PATH,
    cleanup() {
      for (const server of openServers) server.close();
      openServers = [];
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: (err as Error).message || 'internal error' });
};

// Build a minimal Express app that mirrors how server.js wires up middleware:
// JSON body parsing, cookie-parser keyed to the test session secret, and the
// requested router(s) mounted at their paths. routerMounts is { '/path':
// router } or a single router with mountPath; arrays are supported for multi-
// router apps (e.g. exports + imports).
export function createTestApp(routerMounts: Record<string, Router>): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(TEST_SESSION_SECRET));
  for (const [mount, router] of Object.entries(routerMounts)) {
    app.use(mount, router);
  }
  app.use(errorHandler);
  return app;
}

// One-off (agent-less) requests. Use this instead of supertest's `request(app)`
// so the request goes through the file's shared listener rather than binding
// and tearing down a port of its own — see listeningServer above.
export function testRequest(app: Express): request.Agent {
  return request(listeningServer(app));
}

// Returns a supertest agent pre-loaded with a signed lurker_session cookie for
// the given user. Creates a real session row via db/sessions.js — the route
// handlers then go through the unmodified loadSession path.
export type LurkerTestAgent = ReturnType<typeof request.agent>;

export async function createAuthedAgent(app: Express, userId: number): Promise<LurkerTestAgent> {
  const { createSession } = await import('../db/sessions.js');
  const { token } = createSession(userId);
  const signed = 's:' + signCookie(token, TEST_SESSION_SECRET);
  const agent = request.agent(listeningServer(app));
  // request.agent stores cookies by jar, but the simplest reliable approach is
  // to set the Cookie header on every request. Supertest's .set('Cookie',...)
  // sticks for the agent's lifetime.
  agent.set('Cookie', `lurker_session=${encodeURIComponent(signed)}`);
  return agent;
}

// Convenience: build an unauthenticated supertest agent against the app.
export function createAnonAgent(app: Express): LurkerTestAgent {
  return request.agent(listeningServer(app));
}
