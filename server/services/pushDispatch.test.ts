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
type OnFailureFn = (err: unknown, verdict: string) => void;
type Stub = {
  send: Mock<SendFn>;
  classify: Mock<ClassifyFn>;
  onFailure: Mock<OnFailureFn>;
  configured: boolean;
};
const stubs: Record<string, Stub> = {};

function freshStub(): Stub {
  return {
    send: vi.fn<SendFn>(async () => {}),
    classify: vi.fn<ClassifyFn>(() => 'strike'),
    onFailure: vi.fn<OnFailureFn>(() => {}),
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
      onFailure: (err: unknown, verdict: string) => stubs[transport].onFailure(err, verdict),
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

  it('clamps a long body before any transport sees it', async () => {
    addWebpush(user.id, `https://push.test/${user.id}`);
    addNative(user.id, 'fcm', `fcm-${user.id}`);
    await pushService.deliver(user.id, { ...payload, text: 'x'.repeat(5000) });
    for (const stub of [stubs.webpush, stubs.fcm]) {
      const [, , content] = stub.send.mock.calls[0] as [unknown, PushPayload, { body: string }];
      expect(Buffer.byteLength(content.body)).toBeLessThanOrEqual(1024);
      expect(content.body.endsWith('…')).toBe(true);
    }
  });

  it('measures the body after stripping, not the raw text', async () => {
    // Every word coloured: 10 raw bytes per word of 4, and over 1 KB raw, but the
    // stripped body is short enough to go whole.
    addNative(user.id, 'fcm', `fcm-${user.id}`);
    const words = Array.from({ length: 150 }, () => '\x0304word\x03').join(' ');
    await pushService.deliver(user.id, { ...payload, text: words });
    const [, , content] = stubs.fcm.send.mock.calls[0] as [unknown, PushPayload, { body: string }];
    expect(content.body).toBe(Array.from({ length: 150 }, () => 'word').join(' '));
  });

  it('clamps a long network name, which rides in the title too', async () => {
    addNative(user.id, 'fcm', `fcm-${user.id}`);
    await pushService.deliver(user.id, { ...payload, networkName: 'n'.repeat(2100) });
    const [, sent, content] = stubs.fcm.send.mock.calls[0] as [
      unknown,
      PushPayload,
      { title: string },
    ];
    expect(Buffer.byteLength(sent.networkName)).toBeLessThanOrEqual(128);
    expect(content.title).toBe(`bob (${sent.networkName})`);
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

describe('deliver drives the sender failure hook', () => {
  it('calls onFailure once per failed delivery, with the verdict', async () => {
    // The hook exists because the credential reset used to hide inside
    // classify() — invisible at the seam, fired per failing device, and gone in
    // any test that stubbed the sender. Which is to say: exactly here.
    addNative(user.id, 'apns', `apns-${user.id}`);
    const boom = new Error('nope');
    stubs.apns.send = vi.fn<SendFn>(async () => {
      throw boom;
    });
    stubs.apns.classify = vi.fn<ClassifyFn>(() => 'transient');

    await pushService.deliver(user.id, payload);
    expect(stubs.apns.onFailure).toHaveBeenCalledTimes(1);
    expect(stubs.apns.onFailure).toHaveBeenCalledWith(boom, 'transient');
  });

  it('does not call onFailure for a delivery that succeeded', async () => {
    addNative(user.id, 'apns', `apns-${user.id}`);
    await pushService.deliver(user.id, payload);
    expect(stubs.apns.onFailure).not.toHaveBeenCalled();
  });

  it('calls only the failing transport hook', async () => {
    addWebpush(user.id, `https://push.test/${user.id}`);
    addNative(user.id, 'apns', `apns-${user.id}`);
    stubs.apns.send = vi.fn<SendFn>(async () => {
      throw new Error('nope');
    });
    stubs.apns.classify = vi.fn<ClassifyFn>(() => 'transient');

    await pushService.deliver(user.id, payload);
    expect(stubs.apns.onFailure).toHaveBeenCalledTimes(1);
    expect(stubs.webpush.onFailure).not.toHaveBeenCalled();
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

// The push log (#1272): deliver() writes what became of each device, and why a
// push went nowhere, so a "no notification" report can be read off the server.
describe('deliver writes the push log', () => {
  let pushLog: typeof import('../db/pushLog.js');
  beforeAll(async () => {
    pushLog = await import('../db/pushLog.js');
  });

  it('records one sent row per device, with the status the sender resolved', async () => {
    addWebpush(user.id, `https://push.test/${user.id}`);
    addNative(user.id, 'fcm', `fcm-${user.id}`);
    stubs.webpush.send = vi.fn<SendFn>(async () => 201 as unknown as void);
    stubs.fcm.send = vi.fn<SendFn>(async () => 200 as unknown as void);
    await pushService.deliver(user.id, payload);
    const rows = pushLog.listPushLogForUser(user.id, 10);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.transport, r.device, r.status, r.outcome]).toSorted()).toEqual([
      // A native token is close to a credential: its first 8 characters and an
      // ellipsis, the form the warn lines use. A Web Push device is its host.
      ['fcm', `${`fcm-${user.id}`.slice(0, 8)}…`, 200, 'sent'],
      ['webpush', 'push.test', 201, 'sent'],
    ]);
    // What it was about rides on every row; the text never does.
    expect(rows[0]).toMatchObject({ kind: 'dm', network_name: 'Libera', target: 'bob' });
  });

  it('records a failed row with the verdict and the status the error carried', async () => {
    addNative(user.id, 'apns', `apns-${user.id}`);
    stubs.apns.send = vi.fn<SendFn>(async () => {
      throw Object.assign(new Error('nope'), { status: 410 });
    });
    stubs.apns.classify = vi.fn<ClassifyFn>(() => 'permanent');
    await pushService.deliver(user.id, payload);
    expect(pushLog.listPushLogForUser(user.id, 10)).toMatchObject([
      { outcome: 'failed', transport: 'apns', status: 410, reason: 'permanent: described' },
    ]);
  });

  it('records a relay device dropped while the relay is off', async () => {
    // The opt-in holds at the door: this test DB never turned the relay on.
    addWebpush(user.id, `https://push.lurker.chat/relay-to/apns/${user.id}`);
    await pushService.deliver(user.id, payload);
    expect(stubs.webpush.send).not.toHaveBeenCalled();
    expect(pushLog.listPushLogForUser(user.id, 10)).toMatchObject([
      { outcome: 'suppressed', reason: 'relay_off', device: 'push.lurker.chat' },
    ]);
  });

  it('records a device skipped for want of credentials', async () => {
    addNative(user.id, 'apns', `apns-${user.id}`);
    stubs.apns.configured = false;
    await pushService.deliver(user.id, payload);
    expect(pushLog.listPushLogForUser(user.id, 10)).toMatchObject([
      { outcome: 'suppressed', reason: 'unconfigured', transport: 'apns' },
    ]);
  });

  it('records a push dropped for size, once, with no device', async () => {
    addWebpush(user.id, `https://push.test/${user.id}`);
    addNative(user.id, 'apns', `apns-${user.id}`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The target is never cut (a tap has to land in the buffer), so a 240-char
    // one of control characters is what no amount of trimming can fit.
    await pushService.deliver(user.id, {
      ...payload,
      kind: 'kicked',
      target: `#${'\x10'.repeat(240)}`,
    });
    warn.mockRestore();
    expect(stubs.webpush.send).not.toHaveBeenCalled();
    expect(pushLog.listPushLogForUser(user.id, 10)).toMatchObject([
      { outcome: 'suppressed', reason: 'oversize', device: null },
    ]);
  });

  it('writes nothing for a user with no devices (maybePush logs that one)', async () => {
    await pushService.deliver(user.id, payload);
    expect(pushLog.listPushLogForUser(user.id, 10)).toHaveLength(0);
  });
});
