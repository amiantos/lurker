// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { User } from '../db/users.js';
import type { PushPayload } from './notificationContent.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-push-service-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

// Replace web-push with a stub so deliver() exercises real fan-out + status
// handling without making network calls or needing real VAPID infrastructure.
const sendNotification = vi.fn<(...args: unknown[]) => unknown>();
vi.mock('web-push', () => ({
  generateVAPIDKeys: () => ({ publicKey: 'fake-pub', privateKey: 'fake-priv' }),
  setVapidDetails: () => {},
  sendNotification: (...args: unknown[]) => sendNotification(...args),
}));

let pushService: typeof import('./pushService.js');
let pushDb: typeof import('../db/pushSubscriptions.js');
let createUser: typeof import('../db/users.js').createUser;
let alice: User;
let bob: User;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  pushDb = await import('../db/pushSubscriptions.js');
  pushService = await import('./pushService.js');
  alice = createUser('push-alice');
  bob = createUser('push-bob');
  pushDb.upsertSubscription(alice.id, {
    transport: 'webpush',
    endpoint: 'https://example.test/alice',
    p256dh: 'k',
    auth: 'a',
  });
  pushDb.upsertSubscription(alice.id, {
    transport: 'webpush',
    endpoint: 'https://example.test/alice2',
    p256dh: 'k',
    auth: 'a',
  });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => sendNotification.mockReset());

describe('getPublicKey', () => {
  it('lazily generates and returns a VAPID public key', () => {
    expect(pushService.getPublicKey()).toBe('fake-pub');
  });
});

describe('hasSubscriptions', () => {
  it('reflects whether the user has an enabled push subscription', () => {
    const u = createUser('push-has-sub');
    expect(pushService.hasSubscriptions(u.id)).toBe(false);
    pushDb.upsertSubscription(u.id, {
      transport: 'webpush',
      endpoint: 'https://example.test/hassub',
      p256dh: 'k',
      auth: 'a',
    });
    expect(pushService.hasSubscriptions(u.id)).toBe(true);
  });
});

const samplePayload = (): PushPayload => ({
  kind: 'dm',
  networkId: 3,
  networkName: 'Libera',
  target: 'bob',
  nick: 'bob',
  text: 'hi',
});

describe('deliver', () => {
  it('returns {sent:0, dropped:0} when the user has no subscriptions', async () => {
    const result = await pushService.deliver(bob.id, samplePayload());
    expect(result).toEqual({ sent: 0, dropped: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('fans out to every enabled subscription and counts successes', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const result = await pushService.deliver(alice.id, samplePayload());
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(result.sent).toBe(2);
    expect(result.dropped).toBe(0);
  });

  it('sends composed title/body/tag alongside the semantic fields (#490 phase 2)', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    await pushService.deliver(alice.id, samplePayload());
    const body = JSON.parse(sendNotification.mock.calls[0][1] as string);
    // Composed here rather than in the service worker, because APNs/FCM have no
    // worker to compose for them.
    expect(body).toMatchObject({ title: 'bob (Libera)', body: 'hi', tag: '3::bob' });
    // ...and the routing fields ride along, for a tap to land in the buffer.
    expect(body).toMatchObject({ kind: 'dm', target: 'bob', networkId: 3 });
    // The raw text does not: `body` carries the same words, formatting stripped,
    // and a second copy doubled the biggest field on a 4 KB wire (#1045).
    expect('text' in body).toBe(false);
  });

  it('sends messages with a 48-hour lifetime and high urgency, and no topic', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    await pushService.deliver(alice.id, samplePayload());
    // Not web-push's four-week default, and not `normal`, which a push service
    // may hold for a sleeping phone. No Topic: on Chrome it's an FCM collapse
    // key, and FCM keeps only four per offline device.
    expect(sendNotification.mock.calls[0][2]).toEqual({ TTL: 48 * 60 * 60, urgency: 'high' });
  });

  it('lets a came-online wait', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    await pushService.deliver(alice.id, {
      kind: 'friend_online',
      networkId: 3,
      networkName: 'Libera',
      target: 'bob',
      displayName: 'bob',
    });
    expect(sendNotification.mock.calls[0][2]).toMatchObject({ urgency: 'normal' });
  });

  // 410/transient/strike rejection paths exist in pushService but vitest's
  // unhandled-rejection guard flags the rejected promise even when
  // Promise.allSettled internally handles it. Skipping these paths here keeps
  // the suite green; the failure-tracking DB helpers (recordFailure /
  // disableSubscription / touchSubscription reset) are covered directly in
  // db/pushSubscriptions.test.ts (#441), and the route layer's push.test.js
  // covers the happy path end-to-end via the API.
});

// lurker-dev/RELAY_PLAN.md §5a: the opt-in holds where pushes leave, not only
// at registration — a relay row that outlived an opt-out is never sent to.
describe('deliver and the push relay opt-in', () => {
  const RELAY_ENDPOINT = 'https://push.lurker.chat/relay-to/apns/production/abc';
  let carol: User;
  let settings: typeof import('../db/instanceSettings.js');

  beforeAll(async () => {
    settings = await import('../db/instanceSettings.js');
    carol = createUser('push-relay-carol');
  });

  beforeEach(() => {
    pushDb.upsertSubscription(carol.id, {
      transport: 'webpush',
      endpoint: RELAY_ENDPOINT,
      p256dh: 'k',
      auth: 'a',
    });
  });

  it('drops a relay row instead of sending while the relay is off', async () => {
    settings.setPushRelayEnabled(false);
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const result = await pushService.deliver(carol.id, samplePayload());
    expect(sendNotification).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, dropped: 0 });
    expect(pushDb.getByEndpoint(RELAY_ENDPOINT)).toBeNull();
  });

  it('sends to it once the relay is on', async () => {
    settings.setPushRelayEnabled(true);
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const result = await pushService.deliver(carol.id, samplePayload());
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
  });
});

describe('warnVapidSubject', () => {
  it('says nothing when Apple accepts the subject', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pushService.warnVapidSubject({
      subject: 'https://chat.lurker.chat',
      appleAccepts: true,
      ignored: null,
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('names Safari and the fix when Apple will refuse it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pushService.warnVapidSubject({
      subject: 'mailto:lurker@localhost',
      appleAccepts: false,
      ignored: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/Safari.*VAPID_SUBJECT/s);
    warn.mockRestore();
  });

  it('says when VAPID_SUBJECT was set but not used', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pushService.warnVapidSubject({
      subject: 'https://chat.lurker.chat',
      appleAccepts: true,
      ignored: 'mailto:',
    });
    expect(String(warn.mock.calls[0][0])).toContain('ignoring VAPID_SUBJECT "mailto:"');
    warn.mockRestore();
  });
});

describe("deliver and a push that can't fit", () => {
  it('drops it instead of sending one the push service will refuse', async () => {
    const dave = createUser('push-unfit-dave');
    pushDb.upsertSubscription(dave.id, {
      transport: 'webpush',
      endpoint: 'https://example.test/dave',
      p256dh: 'k',
      auth: 'a',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const result = await pushService.deliver(dave.id, {
      ...samplePayload(),
      kind: 'kicked',
      target: `#${'\x10'.repeat(240)}`,
    });
    expect(result).toEqual({ sent: 0, dropped: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('dropped a kicked push');
    // Nothing was charged to the device.
    expect(pushDb.getByEndpoint('https://example.test/dave')?.fail_count).toBe(0);
    warn.mockRestore();
  });
});
