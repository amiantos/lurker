// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, createTestApp, createAuthedAgent, createAnonAgent } from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-settings');

let app;
let agent;
let user;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./settings.js')).default;

  user = createUser('settings-alice');
  app = createTestApp({ '/api/settings': router });
  agent = await createAuthedAgent(app, user.id);
});

afterAll(() => ctx.cleanup());

describe('GET /api/settings/bootstrap', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await createAnonAgent(app).get('/api/settings/bootstrap');
    expect(res.status).toBe(401);
  });

  it('returns the registry + the user\'s current values', async () => {
    const res = await agent.get('/api/settings/bootstrap');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.registry)).toBe(true);
    expect(res.body.registry.length).toBeGreaterThan(0);
    expect(typeof res.body.values).toBe('object');
  });
});

describe('PATCH /api/settings', () => {
  it('rejects a non-object body with 400', async () => {
    const res = await agent.patch('/api/settings').send({ changes: 'not an object' });
    expect(res.status).toBe(400);
  });

  it('persists a valid change and returns the merged values', async () => {
    const res = await agent.patch('/api/settings').send({
      changes: { 'look.font.size': 18 },
    });
    expect(res.status).toBe(200);
    expect(res.body.values['look.font.size']).toBe(18);
  });

  it('rejects an out-of-range int and reports the offending key', async () => {
    const res = await agent.patch('/api/settings').send({
      changes: { 'look.font.size': 5 },
    });
    expect(res.status).toBe(400);
    expect(res.body.key).toBe('look.font.size');
    expect(res.body.error).toMatch(/>= 9/);
  });

  it('rejects unknown keys', async () => {
    const res = await agent.patch('/api/settings').send({
      changes: { 'does.not.exist': true },
    });
    expect(res.status).toBe(400);
    expect(res.body.key).toBe('does.not.exist');
  });

  it('writing the default value drops the override', async () => {
    await agent.patch('/api/settings').send({ changes: { 'look.font.size': 18 } });
    const before = await agent.get('/api/settings/bootstrap');
    expect(before.body.values['look.font.size']).toBe(18);
    // Default is 14 per the registry.
    await agent.patch('/api/settings').send({ changes: { 'look.font.size': 14 } });
    const after = await agent.get('/api/settings/bootstrap');
    expect(after.body.values['look.font.size']).toBeUndefined();
  });
});

describe('DELETE /api/settings/:key', () => {
  it('rejects unknown keys with 400', async () => {
    const res = await agent.delete('/api/settings/no.such.key');
    expect(res.status).toBe(400);
  });

  it('resets a known key', async () => {
    await agent.patch('/api/settings').send({ changes: { 'look.font.size': 22 } });
    const res = await agent.delete('/api/settings/look.font.size');
    expect(res.status).toBe(200);
    expect(res.body.values['look.font.size']).toBeUndefined();
  });
});
