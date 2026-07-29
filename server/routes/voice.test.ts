// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  testRequest,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-voice');

let app: Express;
let agent: LurkerTestAgent;
let user: User;

// Turn voice on by populating the env the service reads. Individual tests toggle
// pieces of this to exercise the gates.
function enableVoice() {
  process.env.LURKER_VOICE_ENABLED = 'true';
  process.env.LIVEKIT_WS_URL = 'ws://sfu.test:7880';
  process.env.LIVEKIT_API_KEY = 'devkey';
  process.env.LIVEKIT_API_SECRET = 'devsecret-long-enough';
}

const savedEnv = { ...process.env };

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./voice.js')).default;
  user = createUser('voice-routes-alice');
  app = createTestApp({ '/api/voice': router });
  agent = await createAuthedAgent(app, user.id);
});

afterEach(() => {
  process.env = { ...savedEnv };
});

afterAll(() => ctx.cleanup());

describe('POST /api/voice/token', () => {
  it('401 when unauthenticated', async () => {
    enableVoice();
    const res = await testRequest(app).post('/api/voice/token').send({ networkId: 1, target: '#dev' });
    expect(res.status).toBe(401);
  });

  it('503 when voice is not enabled on the server', async () => {
    delete process.env.LURKER_VOICE_ENABLED;
    delete process.env.LIVEKIT_WS_URL;
    const res = await agent.post('/api/voice/token').send({ networkId: 1, target: '#dev' });
    expect(res.status).toBe(503);
  });

  it('400 for a missing/invalid networkId', async () => {
    enableVoice();
    const res = await agent.post('/api/voice/token').send({ target: '#dev' });
    expect(res.status).toBe(400);
  });

  it('400 for a missing target', async () => {
    enableVoice();
    const res = await agent.post('/api/voice/token').send({ networkId: 1 });
    expect(res.status).toBe(400);
  });

  it('404 for a network the caller does not own (ownership gate)', async () => {
    enableVoice();
    // networkId 999999 belongs to nobody, so getNetwork(id, user) is undefined —
    // the request is refused before any room token can be minted.
    const res = await agent.post('/api/voice/token').send({ networkId: 999999, target: '#dev' });
    expect(res.status).toBe(404);
  });
});
