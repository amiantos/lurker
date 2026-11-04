// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The push relay opt-in (lurker-dev/RELAY_PLAN.md §5a), end to end: the admin
// switch, what /api/push/config tells the apps, and the registration route
// enforcing it. One suite because the promise spans all three — while the relay
// is off, nothing on this server points at it.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-admin-push');

// pushService resolves the VAPID subject from the environment at import; pin it
// so a developer's exported .env can't change what these tests see.
delete process.env.VAPID_SUBJECT;
delete process.env.WEBAUTHN_ORIGIN;

const RELAY = 'https://push.lurker.chat';

let app: Express;
let adminAgent: LurkerTestAgent;
let userAgent: LurkerTestAgent;
let admin: User;
let plainUser: User;
let db: typeof import('../db/index.js').default;
let resetRelayStatusCache: () => void;

// push.lurker.chat's /status answer (§6.5). fetch is stubbed for every test:
// nothing here may reach the real relay. Turning the relay on asks it, so the
// default is a comped key; the gating tests below change it.
type Answer = { status: number; body: unknown } | 'network-error';
const COMPED: Answer = {
  status: 200,
  body: { registered: true, active: true, comped: true, paidThrough: null },
};
let relayAnswer: Answer = COMPED;
// While set, the relay doesn't answer until it settles (a slow or hung relay).
let relayGate: Promise<void> | null = null;
let relayFetch: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const adminRouter = (await import('./admin.js')).default;
  const pushRouter = (await import('./push.js')).default;
  db = (await import('../db/index.js')).default;
  ({ resetRelayStatusCache } = await import('../services/push/relayStatus.js'));

  admin = createUser('adminpush-root', { role: 'admin' });
  plainUser = createUser('adminpush-user');

  app = createTestApp({ '/api/admin': adminRouter, '/api/push': pushRouter });
  adminAgent = await createAuthedAgent(app, admin.id);
  userAgent = await createAuthedAgent(app, plainUser.id);
});

afterAll(() => ctx.cleanup());

beforeEach(() => {
  db.prepare('DELETE FROM push_subscriptions').run();
  db.prepare(`DELETE FROM instance_settings WHERE key = 'push.relay_enabled'`).run();
  relayAnswer = COMPED;
  relayGate = null;
  resetRelayStatusCache();
  relayFetch = vi.fn<(url: string) => Promise<Response>>(async () => {
    if (relayGate) await relayGate;
    if (relayAnswer === 'network-error') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(relayAnswer.body), { status: relayAnswer.status });
  });
  vi.stubGlobal('fetch', relayFetch);
});

afterEach(() => vi.unstubAllGlobals());

const subscribe = (agent: LurkerTestAgent, endpoint: string) =>
  agent.post('/api/push/subscriptions').send({
    endpoint,
    keys: { p256dh: 'p256-key', auth: 'auth-key' },
  });

const setRelay = (enabled: unknown) => adminAgent.put('/api/admin/push/relay').send({ enabled });

describe('GET /api/admin/push', () => {
  it('is admin-only', async () => {
    const res = await userAgent.get('/api/admin/push');
    expect(res.status).toBe(403);
  });

  it('shows the VAPID key the admin registers, with the relay off by default', async () => {
    const res = await adminAgent.get('/api/admin/push');
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe('string');
    expect(res.body.publicKey.length).toBeGreaterThan(20);
    expect(res.body.relay).toEqual({ url: RELAY, enabled: false, devices: 0, status: null });
    // Neither VAPID_SUBJECT nor a public origin (unset above).
    expect(res.body.vapidSubject).toEqual({
      subject: 'mailto:lurker@localhost',
      appleAccepts: false,
      ignored: null,
    });
  });

  it('is the same key /api/push/config hands out', async () => {
    const adminRes = await adminAgent.get('/api/admin/push');
    const configRes = await userAgent.get('/api/push/config');
    expect(adminRes.body.publicKey).toBe(configRes.body.publicKey);
  });
});

describe('PUT /api/admin/push/relay', () => {
  it('is admin-only', async () => {
    const res = await userAgent.put('/api/admin/push/relay').send({ enabled: true });
    expect(res.status).toBe(403);
  });

  it('wants a boolean', async () => {
    expect((await setRelay('yes')).status).toBe(400);
    expect((await setRelay(undefined)).status).toBe(400);
  });

  it('turns the relay on', async () => {
    const res = await setRelay(true);
    expect(res.status).toBe(200);
    expect(res.body.relay.enabled).toBe(true);
    expect(res.body.removed).toBe(0);
  });
});

describe('/api/push/config', () => {
  it('never mentions the relay while it is off', async () => {
    const res = await userAgent.get('/api/push/config');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('relay');
  });

  it('names the relay once the admin turns it on', async () => {
    await setRelay(true);
    const res = await userAgent.get('/api/push/config');
    expect(res.body.relay).toBe(RELAY);
  });

  it('stops naming it when turned back off', async () => {
    await setRelay(true);
    await setRelay(false);
    const res = await userAgent.get('/api/push/config');
    expect(res.body).not.toHaveProperty('relay');
  });
});

describe('registering a relay endpoint', () => {
  it('is refused while the relay is off', async () => {
    const res = await subscribe(userAgent, `${RELAY}/relay-to/apns/production/abc`);
    expect(res.status).toBe(403);
    const count = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('is matched on origin, not spelling', async () => {
    const res = await subscribe(userAgent, 'https://PUSH.lurker.chat:443/relay-to/fcm/abc');
    expect(res.status).toBe(403);
  });

  it('is matched on the host, whatever the scheme, port or trailing dot', async () => {
    // web-push sends every endpoint over https, so each of these reaches the relay.
    for (const endpoint of [
      'https://push.lurker.chat./relay-to/apns/production/x',
      'https://push.lurker.chat%2E/relay-to/apns/production/x',
      'http://push.lurker.chat/relay-to/apns/production/x',
      'https://push.lurker.chat:8443/relay-to/apns/production/x',
    ]) {
      expect((await subscribe(userAgent, endpoint)).status).toBe(403);
    }
  });

  it('is accepted once the relay is on, and counted for the admin', async () => {
    await setRelay(true);
    const res = await subscribe(userAgent, `${RELAY}/relay-to/apns/production/abc`);
    expect(res.status).toBe(201);
    const admin = await adminAgent.get('/api/admin/push');
    expect(admin.body.relay.devices).toBe(1);
  });

  it('leaves browsers alone either way', async () => {
    const res = await subscribe(userAgent, 'https://fcm.googleapis.com/fcm/send/browser');
    expect(res.status).toBe(201);
  });

  it('only matches the relay host itself', async () => {
    const res = await subscribe(userAgent, 'https://push.lurker.chat.example.com/x');
    expect(res.status).toBe(201);
  });
});

describe('the same phone under another account', () => {
  it('moves a relay endpoint to the latest registrant, like a native token', async () => {
    await setRelay(true);
    const endpoint = `${RELAY}/relay-to/apns/production/phone/key`;
    expect((await subscribe(adminAgent, endpoint)).status).toBe(201);
    // Signed out offline, then a different account signs in on the same phone.
    const res = await userAgent.post('/api/push/subscriptions').send({
      endpoint,
      keys: { p256dh: 'new-p256', auth: 'new-auth' },
    });
    expect(res.status).toBe(201);
    const row = db
      .prepare('SELECT user_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ?')
      .get(endpoint) as { user_id: number; p256dh: string; auth: string };
    expect(row).toEqual({ user_id: plainUser.id, p256dh: 'new-p256', auth: 'new-auth' });
  });

  it("moves the OAuth link too, and the old account's replayed sign-out leaves it alone", async () => {
    await setRelay(true);
    const endpoint = `${RELAY}/relay-to/fcm/phone2/key`;
    expect((await subscribe(adminAgent, endpoint)).status).toBe(201);
    // The first registration came through an OAuth app (the phone's sign-in).
    const oauth = await import('../db/oauth.js');
    const app = oauth.createApp({ clientName: 'Lurker', clientUri: null, redirectUris: [] });
    const token = oauth.findTokenByRaw(oauth.createToken(app.id, admin.id))!;
    db.prepare('UPDATE push_subscriptions SET oauth_token_id = ? WHERE endpoint = ?').run(
      token.id,
      endpoint,
    );
    expect((await subscribe(userAgent, endpoint)).status).toBe(201);
    const row = () =>
      db
        .prepare('SELECT user_id, oauth_token_id FROM push_subscriptions WHERE endpoint = ?')
        .get(endpoint) as { user_id: number; oauth_token_id: number | null } | undefined;
    // The new registrant's link (a session here), so revoking the old account's
    // app can't cascade-delete the new account's phone.
    expect(row()).toEqual({ user_id: plainUser.id, oauth_token_id: null });
    // The old account's sign-out, replayed once it's back online.
    const del = await adminAgent.delete('/api/push/subscriptions').send({ endpoint });
    expect(del.status).toBe(200);
    expect(row()?.user_id).toBe(plainUser.id);
  });

  it('keeps the browser rule for anything on the relay host that names no device', async () => {
    await setRelay(true);
    const endpoint = `${RELAY}/something-else/x`;
    expect((await subscribe(adminAgent, endpoint)).status).toBe(201);
    expect((await subscribe(userAgent, endpoint)).status).toBe(409);
  });

  it("still refuses a browser's endpoint another account holds", async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/shared-browser';
    expect((await subscribe(adminAgent, endpoint)).status).toBe(201);
    expect((await subscribe(userAgent, endpoint)).status).toBe(409);
  });
});

describe('the device count', () => {
  it('leaves out relay rows disabled after repeated failures', async () => {
    await setRelay(true);
    await subscribe(userAgent, `${RELAY}/relay-to/apns/production/live`);
    await subscribe(userAgent, `${RELAY}/relay-to/apns/production/dead`);
    db.prepare(`UPDATE push_subscriptions SET enabled = 0 WHERE endpoint LIKE '%/dead'`).run();
    const res = await adminAgent.get('/api/admin/push');
    expect(res.body.relay.devices).toBe(1);
  });
});

describe('turning the relay off', () => {
  it("deletes every user's relay devices and keeps their browsers", async () => {
    await setRelay(true);
    await subscribe(userAgent, `${RELAY}/relay-to/apns/production/user`);
    await subscribe(adminAgent, `${RELAY}/relay-to/fcm/admin`);
    await subscribe(userAgent, 'https://updates.push.services.mozilla.com/wpush/v2/x');

    const res = await setRelay(false);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(2);
    expect(res.body.relay.devices).toBe(0);

    const left = db.prepare('SELECT endpoint FROM push_subscriptions').all() as {
      endpoint: string;
    }[];
    expect(left.map((r) => r.endpoint)).toEqual([
      'https://updates.push.services.mozilla.com/wpush/v2/x',
    ]);
  });
});

describe('the relay status check (RELAY_PLAN.md §6.5)', () => {
  const answer = (body: object) => ({
    status: 200,
    body: { registered: true, active: true, comped: false, paidThrough: null, ...body },
  });

  it('never asks the relay before the admin opts in, even from the pane', async () => {
    const res = await adminAgent.get('/api/admin/push');
    expect(res.body.relay.status).toBeNull();
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it('asks when the admin checks, before turning it on', async () => {
    relayAnswer = answer({ paidThrough: '2027-10-06T00:00:00Z' });
    const res = await adminAgent.post('/api/admin/push/relay/check');
    expect(res.status).toBe(200);
    expect(res.body.relay.status).toEqual({
      state: 'active',
      comped: false,
      paidThrough: '2027-10-06T00:00:00Z',
    });
    expect(res.body.relay.enabled).toBe(false);
  });

  it('shows the status on the pane once the relay is on', async () => {
    await setRelay(true);
    const res = await adminAgent.get('/api/admin/push');
    expect(res.body.relay.status).toEqual({ state: 'active', comped: true, paidThrough: null });
  });

  it.each([
    ['an unknown key', answer({ registered: false, active: false }), 'inactive'],
    ['a lapsed key', answer({ active: false }), 'inactive'],
    ['a refused signature', { status: 401, body: {} }, 'unauthorized'],
    ['a refused check', { status: 404, body: {} }, 'refused'],
    ['a relay that is down', { status: 503, body: {} }, 'unreachable'],
    ['no network', 'network-error' as const, 'unreachable'],
  ])('refuses to turn on with %s, and stays off', async (_label, a, state) => {
    relayAnswer = a;
    const res = await setRelay(true);
    expect(res.status).toBe(409);
    // The pane words it from the status; the server sends no copy of its own.
    expect(res.body.code).toBe('relay_inactive');
    expect(res.body.error).toBeUndefined();
    expect(res.body.relay.status.state).toBe(state);
    expect(res.body.relay.enabled).toBe(false);
    const config = await userAgent.get('/api/push/config');
    expect(config.body).not.toHaveProperty('relay');
  });

  it('turns on with a paid key', async () => {
    relayAnswer = answer({ paidThrough: '2027-10-06T00:00:00Z' });
    const res = await setRelay(true);
    expect(res.status).toBe(200);
    expect(res.body.relay.enabled).toBe(true);
  });

  it('asks fresh when turning on, whatever was cached', async () => {
    await setRelay(true);
    await adminAgent.get('/api/admin/push'); // caches "comped"
    await setRelay(false);
    relayAnswer = answer({ active: false });
    expect((await setRelay(true)).status).toBe(409);
  });

  it('never asks when turning off, and a failed check never switches it off', async () => {
    await setRelay(true);
    relayAnswer = 'network-error';
    resetRelayStatusCache();
    await adminAgent.get('/api/admin/push'); // starts the refresh in the background
    await vi.waitFor(async () => {
      const pane = await adminAgent.get('/api/admin/push');
      expect(pane.body.relay.status?.state).toBe('unreachable');
      expect(pane.body.relay.enabled).toBe(true);
    });
    relayFetch.mockClear();
    const off = await setRelay(false);
    expect(off.status).toBe(200);
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it('answers the pane at once while the relay hangs', async () => {
    await setRelay(true);
    resetRelayStatusCache();
    let release!: () => void;
    relayGate = new Promise((resolve) => (release = resolve));
    const started = Date.now();
    const pane = await adminAgent.get('/api/admin/push');
    expect(pane.status).toBe(200);
    expect(pane.body.relay.status).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    release();
  });

  it('lets an off that lands during a slow turn-on stand', async () => {
    let release!: () => void;
    relayGate = new Promise((resolve) => (release = resolve));
    const on = setRelay(true).then((r) => r); // .then() sends it
    await vi.waitFor(() => expect(relayFetch).toHaveBeenCalled());
    expect((await setRelay(false)).status).toBe(200);
    release();
    const res = await on;
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('superseded');
    expect(res.body.relay.enabled).toBe(false);
    const pane = await adminAgent.get('/api/admin/push');
    expect(pane.body.relay.enabled).toBe(false);
  });

  it("GET /relay/status waits for the relay's answer, only while opted in", async () => {
    let res = await adminAgent.get('/api/admin/push/relay/status');
    expect(res.body).toEqual({ status: null });
    expect(relayFetch).not.toHaveBeenCalled();

    await setRelay(true);
    resetRelayStatusCache(); // a restart: nothing cached
    relayAnswer = answer({ paidThrough: '2027-10-06T00:00:00Z' });
    res = await adminAgent.get('/api/admin/push/relay/status');
    expect(res.body.status).toEqual({
      state: 'active',
      comped: false,
      paidThrough: '2027-10-06T00:00:00Z',
    });
  });
});

// The push log, admin side (#1272): every user's rows with the username on
// each, or one user's; never a plain user's to read.
describe('GET /api/admin/push/log', () => {
  let pushLog: typeof import('../db/pushLog.js');
  beforeAll(async () => {
    pushLog = await import('../db/pushLog.js');
  });
  beforeEach(() => {
    db.prepare('DELETE FROM push_log').run();
  });

  const subject = { kind: 'highlight', networkId: 1, networkName: 'Libera', target: '#lurker' };

  it('is admin-only', async () => {
    expect((await userAgent.get('/api/admin/push/log')).status).toBe(403);
  });

  it('lists every user, newest first, naming each', async () => {
    pushLog.recordPushLog(plainUser.id, {
      ...subject,
      outcome: 'suppressed',
      reason: 'no_devices',
    });
    pushLog.recordPushLog(admin.id, {
      ...subject,
      outcome: 'sent',
      transport: 'webpush',
      device: 'push.lurker.chat',
      status: 201,
    });
    const res = await adminAgent.get('/api/admin/push/log');
    expect(res.status).toBe(200);
    expect(res.body.log).toMatchObject([
      { username: 'adminpush-root', outcome: 'sent', status: 201 },
      { username: 'adminpush-user', outcome: 'suppressed', reason: 'no_devices' },
    ]);
  });

  it('narrows to one user, and refuses a user that is not an id', async () => {
    pushLog.recordPushLog(plainUser.id, {
      ...subject,
      outcome: 'suppressed',
      reason: 'no_devices',
    });
    pushLog.recordPushLog(admin.id, { ...subject, outcome: 'suppressed', reason: 'no_devices' });
    const one = await adminAgent.get(`/api/admin/push/log?user=${plainUser.id}`);
    expect(one.body.log).toMatchObject([{ username: 'adminpush-user' }]);
    expect((await adminAgent.get('/api/admin/push/log?user=bob')).status).toBe(400);
  });

  it('pages older rows with before', async () => {
    for (let i = 0; i < 3; i++) {
      pushLog.recordPushLog(admin.id, { ...subject, outcome: 'suppressed', reason: 'no_devices' });
    }
    const top = (await adminAgent.get('/api/admin/push/log?limit=2')).body.log;
    const older = (await adminAgent.get(`/api/admin/push/log?limit=2&before=${top[1].id}`)).body
      .log;
    expect(older).toHaveLength(1);
    expect(older[0].id).toBeLessThan(top[1].id);
  });
});
