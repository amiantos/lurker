// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  testRequest,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-api-tokens');

let app: Express;
let agent: LurkerTestAgent;
let intruderAgent: LurkerTestAgent;
let user: User;
let intruder: User;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./apiTokens.js')).default;

  user = createUser('tok-routes-alice');
  intruder = createUser('tok-routes-intruder');
  app = createTestApp({ '/api/api-tokens': router });
  agent = await createAuthedAgent(app, user.id);
  intruderAgent = await createAuthedAgent(app, intruder.id);
});

afterAll(() => ctx.cleanup());

describe('GET /api/api-tokens (auth)', () => {
  it('401 when no session cookie', async () => {
    const res = await testRequest(app).get('/api/api-tokens');
    expect(res.status).toBe(401);
  });

  it('returns an empty list for a new user', async () => {
    const res = await agent.get('/api/api-tokens');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

describe('POST /api/api-tokens', () => {
  it('rejects missing name', async () => {
    const res = await agent.post('/api/api-tokens').send({ scope: 'read' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid scope', async () => {
    const res = await agent.post('/api/api-tokens').send({ name: 'x', scope: 'admin' });
    expect(res.status).toBe(400);
  });

  it('rejects an overlong name', async () => {
    const res = await agent.post('/api/api-tokens').send({ name: 'a'.repeat(200), scope: 'read' });
    expect(res.status).toBe(400);
  });

  it('creates a token and returns the raw value exactly once', async () => {
    const res = await agent.post('/api/api-tokens').send({ name: 'cli', scope: 'read-write' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'cli', scope: 'read-write' });
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(typeof res.body.id).toBe('number');

    // The follow-up GET must not include the raw token in any row.
    const list = await agent.get('/api/api-tokens');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('token');
    expect(row).not.toHaveProperty('token_hash');
    expect(row).not.toHaveProperty('tokenHash');
  });
});

describe('DELETE /api/api-tokens/:id', () => {
  it("revokes the caller's own token (soft, listed with revokedAt set)", async () => {
    const create = await agent.post('/api/api-tokens').send({ name: 'temp', scope: 'read' });
    const id = create.body.id as number;
    const del = await agent.delete(`/api/api-tokens/${id}`);
    expect(del.status).toBe(200);
    const list = await agent.get('/api/api-tokens');
    const row = list.body.items.find((r: { id: number }) => r.id === id);
    expect(row.revokedAt).not.toBeNull();
  });

  it("404 when attempting to revoke another user's token", async () => {
    const mine = await agent.post('/api/api-tokens').send({ name: 'mine', scope: 'read' });
    const del = await intruderAgent.delete(`/api/api-tokens/${mine.body.id}`);
    expect(del.status).toBe(404);
  });

  it('400 for an invalid id', async () => {
    const res = await agent.delete('/api/api-tokens/not-a-number');
    expect(res.status).toBe(400);
  });
});
