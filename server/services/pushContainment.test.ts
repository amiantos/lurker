// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Regression from the #490 review: one broken transport must not take down the
// others.
//
// Unlike pushDispatch.test.ts, this does NOT stub the sender registry — the bug
// lived in the real senders' isConfigured(), so stubbing it away is exactly how
// the original tests missed it. Only the credentials' env is controlled here;
// everything from senderFor() down is real.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PushPayload } from './notificationContent.js';
import type { User } from '../db/users.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-containment-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const sendNotification = vi.fn<(...args: unknown[]) => Promise<{ statusCode: number }>>(
  async () => ({ statusCode: 201 }),
);
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    setVapidDetails: () => {},
    sendNotification: (...args: unknown[]) => sendNotification(...(args as [])),
  },
}));

let pushService: typeof import('./pushService.js');
let pushDb: typeof import('../db/pushSubscriptions.js');
let resetCredentialCache: typeof import('./push/credentials.js').resetCredentialCache;
let createUser: typeof import('../db/users.js').createUser;
let user: User;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  pushDb = await import('../db/pushSubscriptions.js');
  pushService = await import('./pushService.js');
  ({ resetCredentialCache } = await import('./push/credentials.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  sendNotification.mockClear();
  for (const k of [
    'LURKER_APNS_KEY',
    'LURKER_APNS_KEY_ID',
    'LURKER_APNS_TEAM_ID',
    'LURKER_APNS_BUNDLE_ID',
  ]) {
    delete process.env[k];
  }
  resetCredentialCache();
  user = createUser(`u-${Math.random().toString(36).slice(2)}`);
});

const payload: PushPayload = {
  kind: 'dm',
  networkId: 1,
  networkName: 'Libera',
  target: 'bob',
  nick: 'bob',
  text: 'hi',
};

describe('a broken APNs config cannot silence Web Push', () => {
  it('still delivers to the browser when APNs is half-configured', async () => {
    // The exact operator mistake: LURKER_APNS_KEY and _KEY_ID set, _TEAM_ID and
    // _BUNDLE_ID forgotten. Previously apnsCredentials() threw, isConfigured()
    // let it escape, and the throw aborted deliver()'s filter — so this user's
    // browser silently got nothing, forever, with the only clue a single
    // "[push] deliver failed" line.
    process.env.LURKER_APNS_KEY = '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----';
    process.env.LURKER_APNS_KEY_ID = 'KEYID';
    resetCredentialCache();

    pushDb.upsertSubscription(user.id, {
      transport: 'webpush',
      endpoint: `https://push.test/${user.id}`,
      p256dh: 'k',
      auth: 'a',
    });
    pushDb.upsertSubscription(user.id, { transport: 'apns', endpoint: `apnstoken${user.id}` });

    const result = await pushService.deliver(user.id, payload);

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
    // The iOS device is skipped, not deleted and not struck — it starts working
    // the moment the operator fixes the config, with no re-registration.
    const apns = pushDb.listAllForUser(user.id).find((s) => s.transport === 'apns');
    expect(apns).toMatchObject({ enabled: true, fail_count: 0 });
  });

  it('does not throw out of deliver() when a transport is misconfigured', async () => {
    process.env.LURKER_APNS_KEY = 'garbage';
    process.env.LURKER_APNS_KEY_ID = 'KEYID';
    process.env.LURKER_APNS_TEAM_ID = 'TEAM';
    process.env.LURKER_APNS_BUNDLE_ID = 'chat.lurker.app';
    resetCredentialCache();
    pushDb.upsertSubscription(user.id, { transport: 'apns', endpoint: `apnstoken${user.id}` });
    await expect(pushService.deliver(user.id, payload)).resolves.toEqual({ sent: 0, dropped: 0 });
  });
});
