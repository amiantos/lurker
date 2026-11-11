// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { timeHandlers } from './timeHandlers.js';
import { describeRecentSyncWork } from '../services/syncWork.js';

// Hold the event loop, as a slow synchronous query does.
function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin */
  }
}

// The app's shape (app.ts): the timer first of all, and again after the body
// parser. `mounts` picks which, to show what each one is for.
function app(mounts: { first: boolean; afterParsers: boolean }) {
  const a = express();
  if (mounts.first) a.use(timeHandlers);
  a.use(express.json());
  if (mounts.afterParsers) a.use(timeHandlers);
  const router = express.Router();
  router.get('/things/:id', (_req, res) => {
    block(150);
    res.json({});
  });
  router.post('/things/:id', (_req, res) => {
    block(150);
    res.json({});
  });
  a.use('/api', router);
  return a;
}

beforeEach(() => {
  describeRecentSyncWork();
});

describe('timeHandlers', () => {
  it('names a slow handler by its route pattern, never the URL', async () => {
    await request(app({ first: true, afterParsers: true })).get('/api/things/secret-token');
    const line = describeRecentSyncWork();
    expect(line).toMatch(/^longest handler just before: GET \/api\/things\/:id \(\d+ms\)$/);
    expect(line).not.toContain('secret-token');
  });

  it('times a handler that runs after an asynchronously parsed body', async () => {
    await request(app({ first: true, afterParsers: true }))
      .post('/api/things/7')
      .send({ a: 1 });
    expect(describeRecentSyncWork()).toMatch(/POST \/api\/things\/:id/);
  });

  it('needs the mount after the parsers for that: the first alone sees nothing of a request with a body', async () => {
    await request(app({ first: true, afterParsers: false }))
      .post('/api/things/7')
      .send({ a: 1 });
    expect(describeRecentSyncWork()).toBeNull();
  });
});
