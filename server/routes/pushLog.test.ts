// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The push log's user-facing routes (#1272): a user reads their own log and
// their own live clients, and the test push goes to every device they have,
// gates or no gates. The admin side is in adminPush.test.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-push-log');

// Web Push is stubbed so the test push exercises deliver() end to end without a
// network; what the stub answers is what the log should record.
const sendNotification = vi.fn<(...args: unknown[]) => unknown>();
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'fake-pub', privateKey: 'fake-priv' }),
    setVapidDetails: () => {},
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let alice: User;
let bob: User;
let pushLog: typeof import('../db/pushLog.js');
let pushDb: typeof import('../db/pushSubscriptions.js');
let db: typeof import('../db/index.js').default;
let resetTestPushCooldowns: () => void;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const pushRoutes = await import('./push.js');
  const router = pushRoutes.default;
  ({ resetTestPushCooldowns } = pushRoutes);
  pushLog = await import('../db/pushLog.js');
  pushDb = await import('../db/pushSubscriptions.js');
  db = (await import('../db/index.js')).default;

  alice = createUser('pushlog-alice');
  bob = createUser('pushlog-bob');
  app = createTestApp({ '/api/push': router });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
});

afterAll(() => ctx.cleanup());

beforeEach(() => {
  db.prepare('DELETE FROM push_log').run();
  db.prepare('DELETE FROM push_subscriptions').run();
  sendNotification.mockReset();
  resetTestPushCooldowns();
});

const subject = { kind: 'dm', networkId: 1, networkName: 'Libera', target: 'bob', nick: 'bob' };

describe('GET /api/push/log', () => {
  it('requires auth', async () => {
    expect((await createAnonAgent(app).get('/api/push/log')).status).toBe(401);
  });

  it("returns the caller's rows, newest first, and nobody else's", async () => {
    pushLog.recordPushLog(alice.id, { ...subject, outcome: 'suppressed', reason: 'quiet_hours' });
    pushLog.recordPushLog(alice.id, {
      ...subject,
      outcome: 'suppressed',
      reason: 'visible_client',
    });
    pushLog.recordPushLog(bob.id, { ...subject, outcome: 'suppressed', reason: 'no_devices' });
    const res = await aliceAgent.get('/api/push/log');
    expect(res.status).toBe(200);
    expect(res.body.log.map((r: { reason: string }) => r.reason)).toEqual([
      'visible_client',
      'quiet_hours',
    ]);
    // No username on the user's own view, and never a text column.
    expect(res.body.log[0]).not.toHaveProperty('username');
    expect(res.body.log[0]).not.toHaveProperty('text');
  });

  it('takes a limit and ignores a bad one', async () => {
    for (let i = 0; i < 3; i++) {
      pushLog.recordPushLog(alice.id, { ...subject, outcome: 'suppressed', reason: 'no_devices' });
    }
    expect((await aliceAgent.get('/api/push/log?limit=2')).body.log).toHaveLength(2);
    expect((await aliceAgent.get('/api/push/log?limit=nope')).body.log).toHaveLength(3);
    expect((await aliceAgent.get('/api/push/log?limit=0')).body.log).toHaveLength(3);
  });
});

describe('GET /api/push/clients', () => {
  it('requires auth and answers an empty list with no socket open', async () => {
    expect((await createAnonAgent(app).get('/api/push/clients')).status).toBe(401);
    const res = await aliceAgent.get('/api/push/clients');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clients: [] });
  });
});

describe('POST /api/push/test', () => {
  it('requires auth', async () => {
    expect((await createAnonAgent(app).post('/api/push/test')).status).toBe(401);
  });

  it('reports nothing sent for a user with no devices', async () => {
    const res = await aliceAgent.post('/api/push/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 0, dropped: 0, devices: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('counts the devices so "all held" reads differently from "none"', async () => {
    // A relay device while the relay is off: deliver() holds it (relay_off).
    pushDb.upsertSubscription(alice.id, {
      transport: 'webpush',
      endpoint: 'https://push.lurker.chat/relay-to/apns/x',
      p256dh: 'k',
      auth: 'a',
    });
    const res = await aliceAgent.post('/api/push/test');
    expect(res.body).toEqual({ sent: 0, dropped: 0, devices: 1 });
    expect(pushLog.listPushLogForUser(alice.id, 10)).toMatchObject([
      { kind: 'test', outcome: 'suppressed', reason: 'relay_off' },
    ]);
  });

  it('allows one test per account every few seconds, per account', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    expect((await aliceAgent.post('/api/push/test')).status).toBe(200);
    const again = await aliceAgent.post('/api/push/test');
    expect(again.status).toBe(429);
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    expect(again.body.retryAfter).toBeGreaterThan(0);
    // Another account is not held by alice's cooldown.
    expect((await bobAgent.post('/api/push/test')).status).toBe(200);
  });

  it("sends a test to every one of the caller's devices and logs each", async () => {
    pushDb.upsertSubscription(alice.id, {
      transport: 'webpush',
      endpoint: 'https://push.example/alice-1',
      p256dh: 'k',
      auth: 'a',
    });
    pushDb.upsertSubscription(alice.id, {
      transport: 'webpush',
      endpoint: 'https://push.example/alice-2',
      p256dh: 'k',
      auth: 'a',
    });
    pushDb.upsertSubscription(bob.id, {
      transport: 'webpush',
      endpoint: 'https://push.example/bob',
      p256dh: 'k',
      auth: 'a',
    });
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const res = await aliceAgent.post('/api/push/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 2, dropped: 0, devices: 2 });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    // What the device will show, with routing keys every parser accepts (the
    // iOS relay extension refuses an empty target) and nothing to open.
    const body = JSON.parse(sendNotification.mock.calls[0][1] as string);
    expect(body).toMatchObject({
      kind: 'test',
      title: 'Test notification',
      body: 'Lurker can reach this device.',
      networkId: 0,
      target: 'test',
    });
    expect(body.bufferId).toBeUndefined();
    // Each device's row, with the service's answer; bob has none.
    expect(pushLog.listPushLogForUser(alice.id, 10)).toMatchObject([
      { kind: 'test', outcome: 'sent', status: 201, device: 'push.example' },
      { kind: 'test', outcome: 'sent', status: 201, device: 'push.example' },
    ]);
    expect(pushLog.listPushLogForUser(bob.id, 10)).toHaveLength(0);
    expect((await bobAgent.get('/api/push/log')).body.log).toHaveLength(0);
  });

  it('is an answer about the pipe, not the policy: no gate holds it', async () => {
    const { setUserSetting } = await import('../db/settings.js');
    // Quiet hours all day and every kind off; the test still goes out.
    setUserSetting(alice.id, 'notifications.push.quiet_hours.enabled', true);
    setUserSetting(alice.id, 'notifications.push.quiet_hours.start', '00:00');
    setUserSetting(alice.id, 'notifications.push.quiet_hours.end', '23:59');
    setUserSetting(alice.id, 'notifications.dm.enabled', false);
    setUserSetting(alice.id, 'notifications.highlight.enabled', false);
    pushDb.upsertSubscription(alice.id, {
      transport: 'webpush',
      endpoint: 'https://push.example/alice-3',
      p256dh: 'k',
      auth: 'a',
    });
    sendNotification.mockResolvedValue({ statusCode: 201 });
    expect((await aliceAgent.post('/api/push/test')).body).toEqual({
      sent: 1,
      dropped: 0,
      devices: 1,
    });
  });
});
