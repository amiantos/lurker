// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent, createAnonAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-push');

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let alice: User;
let bob: User;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./push.js')).default;

  alice = createUser('push-alice');
  bob = createUser('push-bob');
  app = createTestApp({ '/api/push': router });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
});

afterAll(() => ctx.cleanup());

describe('GET /api/push/config', () => {
  it('requires auth', async () => {
    const res = await createAnonAgent(app).get('/api/push/config');
    expect(res.status).toBe(401);
  });

  it('returns a VAPID public key (generated lazily on first call)', async () => {
    const res = await aliceAgent.get('/api/push/config');
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe('string');
    expect(res.body.publicKey.length).toBeGreaterThan(20);
  });
});

describe('POST /api/push/subscriptions', () => {
  const validBody = (suffix = 'a') => ({
    endpoint: `https://example.test/${suffix}`,
    keys: { p256dh: 'p256-key', auth: 'auth-key' },
    userAgent: 'TestAgent/1.0',
  });

  it('rejects missing endpoint/keys', async () => {
    const res = await aliceAgent.post('/api/push/subscriptions').send({});
    expect(res.status).toBe(400);
  });

  it('creates a subscription that shows up in the list', async () => {
    const create = await aliceAgent.post('/api/push/subscriptions').send(validBody('a'));
    expect(create.status).toBe(201);
    expect(typeof create.body.subscription.id).toBe('number');
    const list = await aliceAgent.get('/api/push/subscriptions');
    expect(list.body.subscriptions.find((s: { endpoint: string }) => s.endpoint === 'https://example.test/a')).toBeTruthy();
  });

  it('refuses to rebind an endpoint that already belongs to a different user', async () => {
    const shared = validBody('shared');
    await aliceAgent.post('/api/push/subscriptions').send(shared);
    const conflict = await bobAgent.post('/api/push/subscriptions').send(shared);
    expect(conflict.status).toBe(409);
  });

  it('re-subscribing the same endpoint for the same user updates rather than dupes', async () => {
    const body = validBody('rebind');
    const r1 = await aliceAgent.post('/api/push/subscriptions').send(body);
    const r2 = await aliceAgent.post('/api/push/subscriptions').send(body);
    expect(r2.status).toBe(201);
    // Same id — UPSERT, not insert-new.
    expect(r2.body.subscription.id).toBe(r1.body.subscription.id);
  });
});

describe('DELETE /api/push/subscriptions', () => {
  it('requires an endpoint in the body', async () => {
    const res = await aliceAgent.delete('/api/push/subscriptions').send({});
    expect(res.status).toBe(400);
  });

  it('removes the matching subscription', async () => {
    await aliceAgent.post('/api/push/subscriptions').send({
      endpoint: 'https://example.test/remove-me',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const res = await aliceAgent.delete('/api/push/subscriptions').send({
      endpoint: 'https://example.test/remove-me',
    });
    expect(res.status).toBe(200);
    const list = await aliceAgent.get('/api/push/subscriptions');
    expect(list.body.subscriptions.find((s: { endpoint: string }) => s.endpoint === 'https://example.test/remove-me')).toBeFalsy();
  });
});

describe('POST /api/push/heartbeat', () => {
  it('reports present=false for an endpoint we don\'t own', async () => {
    const res = await aliceAgent.post('/api/push/heartbeat').send({
      endpoint: 'https://example.test/no-such',
    });
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(false);
  });

  it('updates last_seen_at when the endpoint matches', async () => {
    await aliceAgent.post('/api/push/subscriptions').send({
      endpoint: 'https://example.test/heartbeat',
      keys: { p256dh: 'p', auth: 'a' },
    });
    const res = await aliceAgent.post('/api/push/heartbeat').send({
      endpoint: 'https://example.test/heartbeat',
    });
    expect(res.status).toBe(200);
    expect(res.body.present).toBe(true);
  });
});
