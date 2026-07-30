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

describe('feature flags', () => {
  const withFlag = async (value: string | undefined) => {
    const saved = process.env.LURKER_LINK_PREVIEWS;
    if (value === undefined) delete process.env.LURKER_LINK_PREVIEWS;
    else process.env.LURKER_LINK_PREVIEWS = value;
    try {
      return (await createAnonAgent(app).get('/api/config')).body as {
        features?: { linkPreviews?: boolean };
      };
    } finally {
      if (saved === undefined) delete process.env.LURKER_LINK_PREVIEWS;
      else process.env.LURKER_LINK_PREVIEWS = saved;
    }
  };

  it('reports link previews off by default', async () => {
    // Clients use this to HIDE the two settings rather than offer toggles with no server behind
    // them — the routes aren't even mounted when the flag is off.
    expect((await withFlag(undefined)).features?.linkPreviews).toBe(false);
  });

  it('reports them on once the operator opts in', async () => {
    expect((await withFlag('on')).features?.linkPreviews).toBe(true);
  });
});
