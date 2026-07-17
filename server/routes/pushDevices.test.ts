// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Native device registration routes (#490 phase 4).

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-push-devices');

// Credentials are the thing under test in half of these, so the sender registry
// is stubbed rather than the env poked — what matters here is the route's
// behavior on either answer.
const configured: Record<string, boolean> = { webpush: true, apns: true, fcm: true };

vi.mock('../services/push/index.js', () => ({
  senderFor: (transport: string) => ({
    transport,
    isConfigured: () => configured[transport],
    configHint: () => 'hint',
    send: async () => {},
    classify: () => 'strike',
    describe: () => '',
  }),
  warnUnconfiguredOnce: () => {},
}));

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let alice: User;
let bob: User;
let pushDb: typeof import('../db/pushSubscriptions.js');

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  pushDb = await import('../db/pushSubscriptions.js');
  const router = (await import('./push.js')).default;

  alice = createUser('devices-alice');
  bob = createUser('devices-bob');
  app = createTestApp({ '/api/push': router });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
});

beforeEach(() => {
  configured.webpush = true;
  configured.apns = true;
  configured.fcm = true;
  for (const u of [alice, bob]) {
    for (const s of pushDb.listAllForUser(u.id)) pushDb.deleteById(s.id, u.id);
  }
});

afterAll(() => ctx.cleanup());

describe('POST /api/push/devices', () => {
  it('requires auth', async () => {
    const res = await createAnonAgent(app)
      .post('/api/push/devices')
      .send({ token: 't', transport: 'apns' });
    expect(res.status).toBe(401);
  });

  it('registers an APNs device', async () => {
    const res = await aliceAgent
      .post('/api/push/devices')
      .send({ token: 'apns-token-1', transport: 'apns' });
    expect(res.status).toBe(201);
    expect(res.body.device).toMatchObject({ transport: 'apns' });
    expect(pushDb.getByEndpoint('apns-token-1')).toMatchObject({
      user_id: alice.id,
      transport: 'apns',
      p256dh: null,
      auth: null,
    });
  });

  it('registers an FCM device', async () => {
    const res = await aliceAgent
      .post('/api/push/devices')
      .send({ token: 'fcm-token-1', transport: 'fcm' });
    expect(res.status).toBe(201);
    expect(pushDb.getByEndpoint('fcm-token-1')?.transport).toBe('fcm');
  });

  it('records the user agent so a device list can name the phone', async () => {
    await aliceAgent
      .post('/api/push/devices')
      .set('user-agent', 'Lurker/1.0 (iPhone; iOS 26.0)')
      .send({ token: 'apns-token-ua', transport: 'apns' });
    expect(pushDb.getByEndpoint('apns-token-ua')?.user_agent).toBe('Lurker/1.0 (iPhone; iOS 26.0)');
  });

  it('rejects a missing token', async () => {
    const res = await aliceAgent.post('/api/push/devices').send({ transport: 'apns' });
    expect(res.status).toBe(400);
  });

  it('rejects an absurdly long token', async () => {
    const res = await aliceAgent
      .post('/api/push/devices')
      .send({ token: 'x'.repeat(5000), transport: 'apns' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown transport', async () => {
    const res = await aliceAgent
      .post('/api/push/devices')
      .send({ token: 't', transport: 'carrier-pigeon' });
    expect(res.status).toBe(400);
  });

  it('refuses to register webpush here', async () => {
    // It would file a Web Push row with no keypair — undeliverable, and skipped
    // by every later read, so push would silently never arrive.
    const res = await aliceAgent
      .post('/api/push/devices')
      .send({ token: 'https://push.test/x', transport: 'webpush' });
    expect(res.status).toBe(400);
    expect(pushDb.getByEndpoint('https://push.test/x')).toBeNull();
  });

  it('says so when the server cannot deliver on that transport', async () => {
    // The self-hosted case: a user running the App Store build against their own
    // server, which holds no Apple key. Accepting the row would mean a phone
    // that thinks it has push and never gets any.
    configured.apns = false;
    const res = await aliceAgent
      .post('/api/push/devices')
      .send({ token: 'apns-token-2', transport: 'apns' });
    expect(res.status).toBe(503);
    expect(res.body.transport).toBe('apns');
    expect(pushDb.getByEndpoint('apns-token-2')).toBeNull();
  });

  it('is idempotent — re-registering the same token does not duplicate it', async () => {
    // iOS hands back the same token on every launch.
    await aliceAgent.post('/api/push/devices').send({ token: 'apns-same', transport: 'apns' });
    await aliceAgent.post('/api/push/devices').send({ token: 'apns-same', transport: 'apns' });
    expect(pushDb.listAllForUser(alice.id)).toHaveLength(1);
  });

  it('rebinds a token to the user who signed in on that phone', async () => {
    // Alice signs out (without deregistering — crash, no network), Bob signs in
    // on the same phone and APNs hands back the same token. Refusing would leave
    // Bob permanently unpushable with no UI anywhere to release it.
    await aliceAgent.post('/api/push/devices').send({ token: 'apns-phone', transport: 'apns' });
    const res = await bobAgent
      .post('/api/push/devices')
      .send({ token: 'apns-phone', transport: 'apns' });
    expect(res.status).toBe(201);
    expect(pushDb.getByEndpoint('apns-phone')?.user_id).toBe(bob.id);
    expect(pushDb.listAllForUser(alice.id)).toHaveLength(0);
  });

  it('still refuses to hand a webpush endpoint to another user', async () => {
    // The opposite rule, on the route that owns it — two users share a browser
    // concurrently, so rebinding there would steal notifications.
    await aliceAgent.post('/api/push/subscriptions').send({
      endpoint: 'https://push.test/shared',
      keys: { p256dh: 'k', auth: 'a' },
    });
    const res = await bobAgent.post('/api/push/subscriptions').send({
      endpoint: 'https://push.test/shared',
      keys: { p256dh: 'k2', auth: 'a2' },
    });
    expect(res.status).toBe(409);
    expect(pushDb.getByEndpoint('https://push.test/shared')?.user_id).toBe(alice.id);
  });
});

describe('DELETE /api/push/devices', () => {
  it('deregisters on sign-out', async () => {
    await aliceAgent.post('/api/push/devices').send({ token: 'apns-bye', transport: 'apns' });
    const res = await aliceAgent.delete('/api/push/devices').send({ token: 'apns-bye' });
    expect(res.status).toBe(200);
    expect(pushDb.getByEndpoint('apns-bye')).toBeNull();
  });

  it('cannot deregister another user device', async () => {
    await aliceAgent.post('/api/push/devices').send({ token: 'apns-alice', transport: 'apns' });
    const res = await bobAgent.delete('/api/push/devices').send({ token: 'apns-alice' });
    // Reports ok — there is nothing of Bob's by that token — but Alice's device
    // survives. A 404 here would confirm the token exists to someone who
    // shouldn't know.
    expect(res.status).toBe(200);
    expect(pushDb.getByEndpoint('apns-alice')?.user_id).toBe(alice.id);
  });

  it('rejects a missing token', async () => {
    const res = await aliceAgent.delete('/api/push/devices').send({});
    expect(res.status).toBe(400);
  });

  it('is idempotent', async () => {
    const res = await aliceAgent.delete('/api/push/devices').send({ token: 'never-existed' });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/push/config', () => {
  it('advertises which transports this server can actually deliver on', async () => {
    const res = await aliceAgent.get('/api/push/config');
    expect(res.status).toBe(200);
    expect(res.body.transports).toEqual(['webpush', 'apns', 'fcm']);
  });

  it('reports webpush only on a server with no native credentials', async () => {
    // What a self-hosted server looks like — and what lets the iOS app say
    // "this server does not support push" instead of asking for notification
    // permission and then silently never delivering.
    configured.apns = false;
    configured.fcm = false;
    const res = await aliceAgent.get('/api/push/config');
    expect(res.body.transports).toEqual(['webpush']);
  });

  it('still carries the VAPID key for Web Push', async () => {
    const res = await aliceAgent.get('/api/push/config');
    expect(typeof res.body.publicKey).toBe('string');
  });
});

describe('GET /api/push/subscriptions', () => {
  it('lists a phone and a browser together, without leaking keys', async () => {
    await aliceAgent.post('/api/push/devices').send({ token: 'apns-list', transport: 'apns' });
    await aliceAgent
      .post('/api/push/subscriptions')
      .send({ endpoint: 'https://push.test/list', keys: { p256dh: 'k', auth: 'a' } });

    const res = await aliceAgent.get('/api/push/subscriptions');
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(2);
    expect(res.body.subscriptions.map((s: { transport: string }) => s.transport).sort()).toEqual([
      'apns',
      'webpush',
    ]);
    for (const sub of res.body.subscriptions) {
      expect(sub.p256dh).toBeUndefined();
      expect(sub.auth).toBeUndefined();
    }
  });
});
