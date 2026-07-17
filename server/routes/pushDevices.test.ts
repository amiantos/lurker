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

// Real-shaped tokens. The route validates shape now, because an unvalidated
// token reaches the APNs request path. So a made-up fixture is not merely ugly:
// it is a token the route correctly refuses, and a test built on one proves
// nothing about the path a real device takes.
const apnsToken = (seed: string): string =>
  seed
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, 'a');
const fcmToken = (seed: string): string =>
  `${seed.replace(/[^A-Za-z0-9_-]/g, '_')}:APA91b${'Ab_-9'.repeat(20)}`;

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
      .send({ token: apnsToken('a1'), transport: 'apns' });
    expect(res.status).toBe(201);
    expect(res.body.device).toMatchObject({ transport: 'apns' });
    expect(pushDb.getByEndpoint(apnsToken('a1'))).toMatchObject({
      user_id: alice.id,
      transport: 'apns',
      p256dh: null,
      auth: null,
    });
  });

  it('registers an FCM device', async () => {
    const res = await aliceAgent
      .post('/api/push/devices')
      .send({ token: fcmToken('fcm1'), transport: 'fcm' });
    expect(res.status).toBe(201);
    expect(pushDb.getByEndpoint(fcmToken('fcm1'))?.transport).toBe('fcm');
  });

  it('records the user agent so a device list can name the phone', async () => {
    await aliceAgent
      .post('/api/push/devices')
      .set('user-agent', 'Lurker/1.0 (iPhone; iOS 26.0)')
      .send({ token: apnsToken('ua'), transport: 'apns' });
    expect(pushDb.getByEndpoint(apnsToken('ua'))?.user_agent).toBe('Lurker/1.0 (iPhone; iOS 26.0)');
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

  it('rejects a token that is not the shape APNs issues', async () => {
    // A token was previously anything under 4096 chars, and it goes STRAIGHT
    // into the APNs request path as `/3/device/${token}`. Node's http2 does not
    // validate or encode :path — verified: '/3/device/../../1/apps/other?x=1' is
    // transmitted verbatim — so an authenticated user could steer our requests,
    // carrying our valid provider JWT, at arbitrary paths on Apple's gateway.
    for (const bad of [
      '../../1/apps/other?x=1',
      'abc/def',
      'token with spaces',
      'tok\r\nX-Injected: 1',
      'zzzz', // right charset-ish, far too short
      '#{}',
    ]) {
      const res = await aliceAgent
        .post('/api/push/devices')
        .send({ token: bad, transport: 'apns' });
      expect(res.status, `should reject APNs token ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('accepts a real-shaped APNs token', async () => {
    const real = 'a'.repeat(64);
    const res = await aliceAgent.post('/api/push/devices').send({ token: real, transport: 'apns' });
    expect(res.status).toBe(201);
  });

  it('accepts a longer APNs token, since Apple has room to grow them', async () => {
    const res = await aliceAgent
      .post('/api/push/devices')
      .send({ token: 'b'.repeat(160), transport: 'apns' });
    expect(res.status).toBe(201);
  });

  it('rejects an FCM token outside the registration-token charset', async () => {
    for (const bad of ['../../evil', 'has spaces', 'x'.repeat(10)]) {
      const res = await aliceAgent.post('/api/push/devices').send({ token: bad, transport: 'fcm' });
      expect(res.status, `should reject FCM token ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('accepts a real-shaped FCM registration token', async () => {
    // FCM tokens look like `<instance-id>:<APA91b…>` — colons, hyphens and
    // underscores are all legitimate.
    const real = `cXY-Z_1234567890:APA91b${'A_-x'.repeat(30)}`;
    const res = await aliceAgent.post('/api/push/devices').send({ token: real, transport: 'fcm' });
    expect(res.status).toBe(201);
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
      .send({ token: apnsToken('a2'), transport: 'apns' });
    expect(res.status).toBe(503);
    expect(res.body.transport).toBe('apns');
    expect(pushDb.getByEndpoint(apnsToken('a2'))).toBeNull();
  });

  it('is idempotent — re-registering the same token does not duplicate it', async () => {
    // iOS hands back the same token on every launch.
    await aliceAgent
      .post('/api/push/devices')
      .send({ token: apnsToken('5a3e'), transport: 'apns' });
    await aliceAgent
      .post('/api/push/devices')
      .send({ token: apnsToken('5a3e'), transport: 'apns' });
    expect(pushDb.listAllForUser(alice.id)).toHaveLength(1);
  });

  it('rebinds a token to the user who signed in on that phone', async () => {
    // Alice signs out (without deregistering — crash, no network), Bob signs in
    // on the same phone and APNs hands back the same token. Refusing would leave
    // Bob permanently unpushable with no UI anywhere to release it.
    await aliceAgent
      .post('/api/push/devices')
      .send({ token: apnsToken('9b0e'), transport: 'apns' });
    const res = await bobAgent
      .post('/api/push/devices')
      .send({ token: apnsToken('9b0e'), transport: 'apns' });
    expect(res.status).toBe(201);
    expect(pushDb.getByEndpoint(apnsToken('9b0e'))?.user_id).toBe(bob.id);
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
    await aliceAgent.post('/api/push/devices').send({ token: apnsToken('bbe'), transport: 'apns' });
    const res = await aliceAgent.delete('/api/push/devices').send({ token: apnsToken('bbe') });
    expect(res.status).toBe(200);
    expect(pushDb.getByEndpoint(apnsToken('bbe'))).toBeNull();
  });

  it('cannot deregister another user device', async () => {
    await aliceAgent
      .post('/api/push/devices')
      .send({ token: apnsToken('a11ce'), transport: 'apns' });
    const res = await bobAgent.delete('/api/push/devices').send({ token: apnsToken('a11ce') });
    // Reports ok — there is nothing of Bob's by that token — but Alice's device
    // survives. A 404 here would confirm the token exists to someone who
    // shouldn't know.
    expect(res.status).toBe(200);
    expect(pushDb.getByEndpoint(apnsToken('a11ce'))?.user_id).toBe(alice.id);
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
    await aliceAgent
      .post('/api/push/devices')
      .send({ token: apnsToken('115d'), transport: 'apns' });
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
