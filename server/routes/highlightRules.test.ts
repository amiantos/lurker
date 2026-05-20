// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent, createAnonAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-highlight-rules');

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let alice: User;
let bob: User;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./highlightRules.js')).default;

  alice = createUser('hlrules-alice');
  bob = createUser('hlrules-bob');
  app = createTestApp({ '/api/highlight-rules': router });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
});

afterAll(() => ctx.cleanup());

describe('GET /api/highlight-rules', () => {
  it('requires auth', async () => {
    const res = await createAnonAgent(app).get('/api/highlight-rules');
    expect(res.status).toBe(401);
  });

  it('returns the caller\'s rules only', async () => {
    await aliceAgent.post('/api/highlight-rules').send({ pattern: 'alice' });
    await bobAgent.post('/api/highlight-rules').send({ pattern: 'bob' });

    const aliceList = await aliceAgent.get('/api/highlight-rules');
    expect(aliceList.body.rules.map((r: { pattern: string }) => r.pattern)).toEqual(['alice']);
    const bobList = await bobAgent.get('/api/highlight-rules');
    expect(bobList.body.rules.map((r: { pattern: string }) => r.pattern)).toEqual(['bob']);
  });
});

describe('POST /api/highlight-rules', () => {
  it('creates a plain rule by default', async () => {
    const res = await aliceAgent.post('/api/highlight-rules').send({ pattern: 'review' });
    expect(res.status).toBe(201);
    expect(res.body.rule.pattern).toBe('review');
    expect(res.body.rule.kind).toBe('plain');
    expect(res.body.rule.enabled).toBe(true);
    expect(res.body.rule.case_sensitive).toBe(false);
  });

  it('rejects an empty pattern', async () => {
    const res = await aliceAgent.post('/api/highlight-rules').send({ pattern: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it('rejects an invalid kind', async () => {
    const res = await aliceAgent.post('/api/highlight-rules').send({
      pattern: 'x', kind: 'fuzzy',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unparseable regex up-front', async () => {
    const res = await aliceAgent.post('/api/highlight-rules').send({
      pattern: '[invalid', kind: 'regex',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid regex/);
  });
});

describe('PATCH /api/highlight-rules/:id', () => {
  it('updates enabled flag', async () => {
    const create = await aliceAgent.post('/api/highlight-rules').send({ pattern: 'toggle' });
    const id = create.body.rule.id;
    const res = await aliceAgent.patch(`/api/highlight-rules/${id}`).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.rule.enabled).toBe(false);
  });

  it('returns 404 when the rule is not owned by the caller', async () => {
    const created = await bobAgent.post('/api/highlight-rules').send({ pattern: 'not-yours' });
    const res = await aliceAgent.patch(`/api/highlight-rules/${created.body.rule.id}`).send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it('returns 400 on a non-integer id', async () => {
    const res = await aliceAgent.patch('/api/highlight-rules/abc').send({ enabled: false });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/highlight-rules/:id', () => {
  it('removes a rule the caller owns', async () => {
    const create = await aliceAgent.post('/api/highlight-rules').send({ pattern: 'gone' });
    const id = create.body.rule.id;
    const res = await aliceAgent.delete(`/api/highlight-rules/${id}`);
    expect(res.status).toBe(200);
    // Subsequent fetch shouldn't list it.
    const list = await aliceAgent.get('/api/highlight-rules');
    expect(list.body.rules.find((r: { id: number }) => r.id === id)).toBeUndefined();
  });

  it('returns 404 for a rule that isn\'t the caller\'s', async () => {
    const created = await bobAgent.post('/api/highlight-rules').send({ pattern: 'still-bobs' });
    const res = await aliceAgent.delete(`/api/highlight-rules/${created.body.rule.id}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 on a non-integer id', async () => {
    const res = await aliceAgent.delete('/api/highlight-rules/abc');
    expect(res.status).toBe(400);
  });
});
