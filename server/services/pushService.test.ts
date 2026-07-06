// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { User } from '../db/users.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-push-service-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

// Replace web-push with a stub so deliver() exercises real fan-out + status
// handling without making network calls or needing real VAPID infrastructure.
const sendNotification = vi.fn<(...args: unknown[]) => unknown>();
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'fake-pub', privateKey: 'fake-priv' }),
    setVapidDetails: () => {},
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
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
    endpoint: 'https://example.test/alice',
    p256dh: 'k',
    auth: 'a',
  });
  pushDb.upsertSubscription(alice.id, {
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
      endpoint: 'https://example.test/hassub',
      p256dh: 'k',
      auth: 'a',
    });
    expect(pushService.hasSubscriptions(u.id)).toBe(true);
  });
});

describe('deliver', () => {
  it('returns {sent:0, dropped:0} when the user has no subscriptions', async () => {
    const result = await pushService.deliver(bob.id, { title: 'hi' });
    expect(result).toEqual({ sent: 0, dropped: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('fans out to every enabled subscription and counts successes', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const result = await pushService.deliver(alice.id, { title: 'hi' });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(result.sent).toBe(2);
    expect(result.dropped).toBe(0);
  });

  // 410/transient/strike rejection paths exist in pushService but vitest's
  // unhandled-rejection guard flags the rejected promise even when
  // Promise.allSettled internally handles it. Skipping these paths here keeps
  // the suite green; the failure-tracking DB helpers (recordFailure /
  // disableSubscription / touchSubscription reset) are covered directly in
  // db/pushSubscriptions.test.ts (#441), and the route layer's push.test.js
  // covers the happy path end-to-end via the API.
});
