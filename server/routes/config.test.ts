// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Edition is resolved from LURKER_EDITION the first time getEdition() runs and
// then cached for the process. vitest runs each test file in its own process, so
// setting it here before importing the router scopes it to this file and lets us
// assert the endpoint reflects the hosted-node edition.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NEW_ADMIN_PANEL = '1';

import type { Express } from 'express';
import { createTestApp, createAnonAgent } from '../test-utils/testApp.js';

let app: Express;

beforeAll(async () => {
  const router = (await import('./config.js')).default;
  app = createTestApp({ '/api/config': router });
});

afterAll(() => {
  delete process.env.LURKER_EDITION;
  delete process.env.LURKER_NEW_ADMIN_PANEL;
});

describe('GET /api/config', () => {
  it('is public (no auth) and reports the edition + feature flags', async () => {
    const res = await createAnonAgent(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.edition).toBe('node');
    expect(res.body.newAdminPanel).toBe(true);
  });
});
