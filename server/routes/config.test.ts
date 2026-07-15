// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Edition is resolved from LURKER_EDITION the first time getEdition() runs and
// then cached for the process. vitest runs each test file in its own process, so
// setting it here before importing the router scopes it to this file and lets us
// assert the endpoint reflects the hosted-node edition.
process.env.LURKER_EDITION = 'node';

import type { Express } from 'express';
import { createTestApp, createAnonAgent } from '../test-utils/testApp.js';

let app: Express;

beforeAll(async () => {
  const router = (await import('./config.js')).default;
  app = createTestApp({ '/api/config': router });
});

afterAll(() => {
  delete process.env.LURKER_EDITION;
});

describe('GET /api/config', () => {
  it('is public (no auth) and reports the edition', async () => {
    const res = await createAnonAgent(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.edition).toBe('node');
  });

  // #569: a native client reads these to check compatibility before opening the
  // WebSocket, so they must be present and unauthenticated.
  it('advertises the protocol version and minimum supported version', async () => {
    const { PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } = await import('../protocol.js');
    const res = await createAnonAgent(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(res.body.minProtocolVersion).toBe(MIN_PROTOCOL_VERSION);
  });
});
