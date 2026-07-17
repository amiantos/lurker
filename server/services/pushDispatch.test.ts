// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// deliver()'s orchestration across transports (#490 phase 3).
//
// The senders are mocked at the seam on purpose: what's under test is the part
// that is NOT per-provider — dispatching each subscription to its own transport,
// skipping transports with no credentials, and turning a FailureClass into the
// right thing happening to the row. Each provider's own classify() is covered in
// push/classify.test.ts, and the wire formats in push/wireFormat.test.ts.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, type Mock } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PushSender } from './push/types.js';
import type { PushPayload } from './notificationContent.js';
import type { User } from '../db/users.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dispatch-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

// A controllable stand-in per transport. The factory reads these at call time,
// so each test can rewire behavior without re-importing.
type SendFn = (sub: unknown, payload: unknown, content: unknown) => Promise<void>;
type ClassifyFn = (err: unknown) => string;
type Stub = {
  send: Mock<SendFn>;
  classify: Mock<ClassifyFn>;
  configured: boolean;
};
const stubs: Record<string, Stub> = {};

function freshStub(): Stub {
  return {
    send: vi.fn<SendFn>(async () => {}),
    classify: vi.fn<ClassifyFn>(() => 'strike'),
    configured: true,
  };
}

vi.mock('./push/index.js', () => ({
  senderFor: (transport: string): PushSender =>
    ({
      transport,
      isConfigured: () => stubs[transport].configured,
      configHint: () => 'hint',
      send: (sub: unknown, payload: unknown, content: unknown) =>
        stubs[transport].send(sub, payload, content),
      classify: (err: unknown) => stubs[transport].classify(err),
      describe: () => 'described',
    }) as unknown as PushSender,
  warnUnconfiguredOnce: () => {},
}));

vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    setVapidDetails: () => {},
    sendNotification: async () => {},
  },
}));

let pushService: typeof import('./pushService.js');
let pushDb: typeof import('../db/pushSubscriptions.js');
let createUser: typeof import('../db/users.js').createUser;
let user: User;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  pushDb = await import('../db/pushSubscriptions.js');
  pushService = await import('./pushService.js');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  for (const t of ['webpush', 'apns', 'fcm']) stubs[t] = freshStub();
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

function addWebpush(u: number, endpoint: string): void {
  pushDb.upsertSubscription(u, { transport: 'webpush', endpoint, p256dh: 'k', auth: 'a' });
}
function addNative(u: number, transport: 'apns' | 'fcm', endpoint: string): void {
  pushDb.upsertSubscription(u, { transport, endpoint });
}

describe('deliver dispatches by transport', () => {
  it('sends each subscription through its own sender', async () => {
    addWebpush(user.id, `https://push.test/${user.id}`);
    addNative(user.id, 'apns', `apns-${user.id}`);
    addNative(user.id, 'fcm', `fcm-${user.id}`);

    const result = await pushService.deliver(user.id, payload);

    expect(stubs.webpush.send).toHaveBeenCalledTimes(1);
    expect(stubs.apns.send).toHaveBeenCalledTimes(1);
    expect(stubs.fcm.send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 3, dropped: 0 });
    // The sender receives its OWN subscription — a crossed wire here would hand
    // an APNs device token to the Web Push sender.
    expect(stubs.apns.send.mock.calls[0][0]).toMatchObject({ endpoint: `apns-${user.id}` });
  });

  it('composes once and hands every transport the same content', async () => {
    addWebpush(user.id, `https://push.test/${user.id}`);
    addNative(user.id, 'apns', `apns-${user.id}`);
    await pushService.deliver(user.id, payload);
    const webContent = stubs.webpush.send.mock.calls[0][2];
    const apnsContent = stubs.apns.send.mock.calls[0][2];
    expect(webContent).toEqual({ title: 'bob (Libera)', body: 'hi', tag: '1::bob' });
    expect(apnsContent).toEqual(webContent);
  });

  it('one transport failing does not stop the others', async () => {
    addWebpush(user.id, `https://push.test/${user.id}`);
    addNative(user.id, 'apns', `apns-${user.id}`);
    stubs.apns.send = vi.fn<SendFn>(async () => {
      throw new Error('apns down');
    });
    stubs.apns.classify = vi.fn<ClassifyFn>(() => 'transient');

    const result = await pushService.deliver(user.id, payload);
    expect(stubs.webpush.send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, dropped: 1 });
  });
});

describe('deliver skips unconfigured transports', () => {
  it('does not attempt a transport with no credentials', async () => {
    // The self-hosted case: an iOS device registered, but the server holds no
    // Apple key. Attempting would throw, count as a failure, and eventually
    // disable a device for a reason that isn't the device's fault.
    addNative(user.id, 'apns', `apns-${user.id}`);
    stubs.apns.configured = false;

    const result = await pushService.deliver(user.id, payload);
    expect(stubs.apns.send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, dropped: 0 });
    // Crucially the subscription SURVIVES — it starts working the moment the
    // operator configures the key, with no re-registration.
    expect(pushDb.listEnabledForUser(user.id)).toHaveLength(1);
  });

  it('still delivers to configured transports alongside an unconfigured one', async () => {
    addWebpush(user.id, `https://push.test/${user.id}`);
    addNative(user.id, 'apns', `apns-${user.id}`);
    stubs.apns.configured = false;

    const result = await pushService.deliver(user.id, payload);
    expect(stubs.webpush.send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, dropped: 0 });
  });
});

describe('deliver acts on the failure class', () => {
  async function failWith(verdict: string, transport: 'webpush' | 'apns' = 'apns') {
    if (transport === 'apns') addNative(user.id, 'apns', `apns-${user.id}`);
    else addWebpush(user.id, `https://push.test/${user.id}`);
    stubs[transport].send = vi.fn<SendFn>(async () => {
      throw new Error('nope');
    });
    stubs[transport].classify = vi.fn<ClassifyFn>(() => verdict);
    return pushService.deliver(user.id, payload);
  }

  it('permanent deletes the subscription', async () => {
    const result = await failWith('permanent');
    expect(result).toEqual({ sent: 0, dropped: 1 });
    expect(pushDb.listAllForUser(user.id)).toHaveLength(0);
  });

  it('transient keeps the subscription and does not strike it', async () => {
    // A rate limit or an outage during a burst must not march a healthy device
    // toward disabled — and for native, a credential fault fails identically for
    // EVERY device, so charging it to one would take the whole fleet down.
    const result = await failWith('transient');
    expect(result).toEqual({ sent: 0, dropped: 1 });
    const [sub] = pushDb.listAllForUser(user.id);
    expect(sub).toMatchObject({ enabled: true, fail_count: 0 });
  });

  it('strike increments the streak but keeps the subscription enabled', async () => {
    const result = await failWith('strike');
    expect(result).toEqual({ sent: 0, dropped: 1 });
    expect(pushDb.listAllForUser(user.id)[0]).toMatchObject({ enabled: true, fail_count: 1 });
  });

  it('disables a subscription after enough consecutive strikes', async () => {
    addNative(user.id, 'apns', `apns-${user.id}`);
    stubs.apns.send = vi.fn<SendFn>(async () => {
      throw new Error('nope');
    });
    stubs.apns.classify = vi.fn<ClassifyFn>(() => 'strike');
    for (let i = 0; i < 5; i++) await pushService.deliver(user.id, payload);
    expect(pushDb.listAllForUser(user.id)[0]).toMatchObject({ enabled: false, fail_count: 5 });
    // Disabled means it stops being attempted at all (#441).
    stubs.apns.send.mockClear();
    await pushService.deliver(user.id, payload);
    expect(stubs.apns.send).not.toHaveBeenCalled();
  });

  it('a success resets the failure streak', async () => {
    addNative(user.id, 'apns', `apns-${user.id}`);
    stubs.apns.send = vi.fn<SendFn>(async () => {
      throw new Error('nope');
    });
    stubs.apns.classify = vi.fn<ClassifyFn>(() => 'strike');
    await pushService.deliver(user.id, payload);
    await pushService.deliver(user.id, payload);
    expect(pushDb.listAllForUser(user.id)[0].fail_count).toBe(2);

    stubs.apns.send = vi.fn<SendFn>(async () => {});
    await pushService.deliver(user.id, payload);
    expect(pushDb.listAllForUser(user.id)[0].fail_count).toBe(0);
  });

  it('deletes only the failing subscription, not the user other devices', async () => {
    addWebpush(user.id, `https://push.test/${user.id}`);
    addNative(user.id, 'apns', `apns-${user.id}`);
    stubs.apns.send = vi.fn<SendFn>(async () => {
      throw new Error('gone');
    });
    stubs.apns.classify = vi.fn<ClassifyFn>(() => 'permanent');

    await pushService.deliver(user.id, payload);
    const left = pushDb.listAllForUser(user.id);
    expect(left).toHaveLength(1);
    expect(left[0].transport).toBe('webpush');
  });
});
