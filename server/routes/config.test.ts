// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The dcc flag reads services/dccConfig, which reaches the db layer.
import '../test-utils/isolateDb.js';
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

describe('the bouncer flag', () => {
  // The pane is hidden without it; the port it would name stays behind auth.
  it('follows LURKER_BOUNCER_ENABLED, and is off in the hosted edition', async () => {
    process.env.LURKER_BOUNCER_ENABLED = 'true';
    try {
      // This file runs as the node edition, which never runs a bouncer.
      const hosted = (await createAnonAgent(app).get('/api/config')).body as {
        features?: { bouncer?: boolean };
      };
      expect(hosted.features?.bouncer).toBe(false);
    } finally {
      delete process.env.LURKER_BOUNCER_ENABLED;
    }
  });
});

describe('the dcc flag', () => {
  it('is off in the hosted edition even with LURKER_DCC_ENABLED set', async () => {
    process.env.LURKER_DCC_ENABLED = '1';
    try {
      const hosted = (await createAnonAgent(app).get('/api/config')).body as {
        features?: { dcc?: boolean };
      };
      expect(hosted.features?.dcc).toBe(false);
    } finally {
      delete process.env.LURKER_DCC_ENABLED;
    }
  });
});

describe('feature flags', () => {
  const withDecoder = async (value: string | undefined) => {
    const saved = process.env.LURKER_PREVIEWS_URL;
    if (value === undefined) delete process.env.LURKER_PREVIEWS_URL;
    else process.env.LURKER_PREVIEWS_URL = value;
    try {
      return (await createAnonAgent(app).get('/api/config')).body as {
        features?: { linkPreviews?: boolean };
      };
    } finally {
      if (saved === undefined) delete process.env.LURKER_PREVIEWS_URL;
      else process.env.LURKER_PREVIEWS_URL = saved;
    }
  };

  it('reports link previews off when no decoder is configured', async () => {
    // Clients use this to HIDE the two settings rather than offer toggles with no server behind
    // them — the routes aren't even mounted when the feature is off, and off IS "no decoder URL".
    expect((await withDecoder(undefined)).features?.linkPreviews).toBe(false);
  });

  it('reports them on once the operator points at a decoder', async () => {
    expect((await withDecoder('http://lurker-previews:8030')).features?.linkPreviews).toBe(true);
  });
});
