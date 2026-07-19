// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Characterization cover for maybePush's gate chain (#490).
//
// The native-push work (APNs + FCM) replaces the delivery transport underneath
// pushService while leaving the *decision* to push untouched. That decision had
// no end-to-end test: wsHub.test.ts covers the pieces around it (the badge
// total, the heartbeat sweep) but nothing drove an IRC event all the way to a
// push. Every assertion here is a statement about behavior as it exists TODAY —
// if one fails after the transport refactor, the refactor changed something it
// was supposed to leave alone.
//
// maybePush is a closure inside attachWsHub and can't be called directly.
// Extracting it first would mean refactoring the very thing this file exists to
// protect, so instead this drives the real path — ircManager.emit('event') →
// decorateMessage → maybePush → pushService.deliver — and mocks pushService,
// which is exactly the seam the transport work replaces. What's asserted is
// therefore the gate decision and the payload handed across that seam, not how
// (or whether) a notification ultimately reaches a device.
//
// The presence gate needs a genuinely visible client, and visibility is only
// reachable over a live socket (the `presence` verb), so these tests run a real
// http server + `ws` client rather than a mock socket.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { setupTestDb, TEST_SESSION_SECRET } from '../test-utils/testApp.js';

const testDb = setupTestDb('wshub-push');

// Reassigned per test; the factory below closes over the binding and reads it at
// call time, so each test gets a fresh spy. (Same lazy-factory trick as
// pushService.test.ts's web-push mock — the factory body doesn't run until the
// first dynamic import inside beforeAll, by which point these are initialized.)
let deliverMock: Mock<(userId: number, payload: unknown) => Promise<unknown>>;
let hasSubsMock: Mock<(userId: number) => boolean>;

vi.mock('./pushService.js', () => ({
  hasSubscriptions: (userId: number) => hasSubsMock(userId),
  deliver: (userId: number, body: unknown) => deliverMock(userId, body),
  getPublicKey: () => 'test-vapid-key',
}));

// A deliver spy that resolves like the real one. Tests that assert "no push
// after a state change" re-arm with this to drop earlier calls.
const freshDeliver = (): typeof deliverMock =>
  vi.fn<(userId: number, payload: unknown) => Promise<unknown>>(async () => ({
    sent: 1,
    dropped: 0,
  }));

// Minutes-since-midnight → 'HH:MM', wrapping across the day boundary so a
// window built around "now" is still valid near midnight.
function hhmm(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Minutes-since-midnight of "now" in UTC, to pair with a pinned system.timezone.
const nowUtcMinutes = (): number => new Date().getUTCHours() * 60 + new Date().getUTCMinutes();

let ircManager: typeof import('./ircManager.js').default;
let ignoreRulesService: typeof import('./ignoreRulesService.js').default;
let setUserSetting: typeof import('../db/settings.js').setUserSetting;
let deleteUserSetting: typeof import('../db/settings.js').deleteUserSetting;
let writeAwayMarker: typeof import('../db/userAwayState.js').writeAwayMarker;
let writeBackMarker: typeof import('../db/userAwayState.js').writeBackMarker;
let setChannelNotifyAlways: typeof import('../db/channelNotify.js').setChannelNotifyAlways;
let createSession: typeof import('../db/sessions.js').createSession;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let buffers: typeof import('../db/buffers.js');

let server: http.Server;
let url: string;
let userId: number;
let networkId: number;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ setUserSetting, deleteUserSetting } = await import('../db/settings.js'));
  ({ writeAwayMarker, writeBackMarker } = await import('../db/userAwayState.js'));
  ({ setChannelNotifyAlways } = await import('../db/channelNotify.js'));
  ({ createSession } = await import('../db/sessions.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  buffers = await import('../db/buffers.js');
  ircManager = (await import('./ircManager.js')).default;
  ignoreRulesService = (await import('./ignoreRulesService.js')).default;
  const { attachWsHub } = await import('./wsHub.js');

  userId = createUser('pushuser').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'irc.example',
    port: 6697,
    tls: true,
    nick: 'pushuser',
  })!.id;

  server = http.createServer();
  attachWsHub(server, TEST_SESSION_SECRET);
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind synchronously to a TCP port');
  }
  server.unref();
  url = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(() => {
  server.close();
  testDb.cleanup();
});

beforeEach(() => {
  deliverMock = freshDeliver();
  hasSubsMock = vi.fn<(userId: number) => boolean>(() => true);
  // Each test starts from registry defaults and no rules/away state. Settings
  // are cleared via the db layer rather than settingsService, which deletes rows
  // that equal the default and would make "explicitly set to the default" and
  // "unset" indistinguishable here.
  for (const key of [
    'notifications.dm.enabled',
    'notifications.highlight.enabled',
    'notifications.always_notify.enabled',
    'notifications.friend_online.enabled',
    'notifications.push.mute_when_away',
    'notifications.push.quiet_hours.enabled',
    'notifications.push.quiet_hours.start',
    'notifications.push.quiet_hours.end',
    'system.timezone',
  ]) {
    deleteUserSetting(userId, key);
  }
  for (const rule of ignoreRulesService.list(userId, networkId)) {
    ignoreRulesService.removeById(userId, networkId, rule.id);
  }
  for (const rule of ignoreRulesService.listGlobal(userId)) {
    ignoreRulesService.removeById(userId, null, rule.id);
  }
  writeBackMarker(userId, new Date().toISOString());
});

// A DM from bob. `notify` is derived, not passed: a non-channel, non-server
// target on a 'message' makes decorateMessage set dm → notify, which is the
// cheapest way into the gate chain.
function emitDm(overrides: Record<string, unknown> = {}): void {
  ircManager.emit('event', {
    userId,
    networkId,
    type: 'message',
    target: 'bob',
    nick: 'bob',
    userhost: 'bob!bob@example.host',
    text: 'ping',
    time: new Date().toISOString(),
    id: 1,
    self: false,
    ...overrides,
  });
}

function emitChannel(overrides: Record<string, unknown> = {}): void {
  emitDm({ target: '#lurker', ...overrides });
}

// maybePush's deliver() is fire-and-forget (.catch()'d, never awaited), so the
// emit returns before the mock is called. One macrotask turn is enough to let
// the promise chain settle.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function pushed(): Promise<boolean> {
  await settle();
  return deliverMock.mock.calls.length > 0;
}

async function payload(): Promise<Record<string, unknown>> {
  await settle();
  expect(deliverMock).toHaveBeenCalled();
  return deliverMock.mock.calls[0][1] as Record<string, unknown>;
}

// Resolve on the socket's next inbound frame, or reject on error/timeout.
// Every exit path detaches both listeners and clears the timer — a `once` that
// never fires stays attached, so resolving via 'message' would otherwise strand
// the 'error' handler (and a timeout would strand both).
function nextMessage(ws: WebSocket, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    function finish(err?: Error) {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      if (err) reject(err);
      else resolve();
    }
    const onMessage = () => finish();
    const onError = (err: Error) => finish(err);
    timer = setTimeout(() => finish(new Error(`timed out waiting for ${what}`)), 5000);
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

// Opens a real socket and reports presence, resolving only once the server has
// definitely applied it.
//
// The presence verb sends no reply, so there is nothing to await directly. This
// used to `await settle()` — one macrotask turn — and hope that covered a real
// WebSocket round trip: send over loopback, server receives, parses, mutates
// ws.presence. Under full-suite CPU contention that tick can fire first, leaving
// presence unset, so a DM pushes and the "does not push when a client is
// visible" test sees true. That was a rare, load-dependent flake.
//
// Instead, follow presence with a verb that DOES reply. The socket processes
// inbound frames in order, so the snapshot coming back proves the presence frame
// ahead of it was already handled — an ordering guarantee rather than a timing
// guess, and it can't be outrun by a slow machine.
//
// Returns a closer the test must call, or the socket leaks into the next test's
// socketsByUser and silently suppresses push. That's also why the failure path
// closes the socket itself: if setup throws, the caller never receives the
// closer, so an un-closed socket would linger as a phantom VISIBLE client and
// silently suppress push in every later test in this file — turning one real
// failure into a cascade of misleading ones.
async function connectWithPresence(visible: boolean): Promise<() => Promise<void>> {
  const { token } = createSession(userId);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const close = () =>
    new Promise<void>((resolve) => {
      ws.on('close', () => resolve());
      ws.close();
    });
  try {
    await nextMessage(ws, 'the connect snapshot');
    ws.send(JSON.stringify({ type: 'presence', visible }));
    ws.send(JSON.stringify({ type: 'snapshot' }));
    await nextMessage(ws, 'the snapshot barrier after presence');
  } catch (err) {
    await close();
    throw err;
  }
  return close;
}

describe('maybePush gate chain', () => {
  it('pushes a DM when nothing suppresses it', async () => {
    emitDm();
    expect(await pushed()).toBe(true);
  });

  it('does not push an event that does not notify', async () => {
    // A plain channel message: not a DM, not matched, no notify_always.
    emitChannel();
    expect(await pushed()).toBe(false);
  });

  it('does not push your own message', async () => {
    emitDm({ self: true });
    expect(await pushed()).toBe(false);
  });

  it('does not push a CTCP line even in a notify_always channel', async () => {
    setChannelNotifyAlways(userId, networkId, '#lurker', true);
    try {
      emitChannel({ type: 'ctcp' });
      expect(await pushed()).toBe(false);
    } finally {
      setChannelNotifyAlways(userId, networkId, '#lurker', false);
    }
  });

  it('does not push when a client is visible', async () => {
    const close = await connectWithPresence(true);
    try {
      emitDm();
      expect(await pushed()).toBe(false);
    } finally {
      await close();
    }
  });

  it('pushes when a client is connected but not visible', async () => {
    // The distinction that matters on mobile: an open socket is not presence.
    // A backgrounded app holds its socket and must still receive push.
    const close = await connectWithPresence(false);
    try {
      emitDm();
      expect(await pushed()).toBe(true);
    } finally {
      await close();
    }
  });

  it('does not push when the user has no subscriptions', async () => {
    hasSubsMock = vi.fn<(userId: number) => boolean>(() => false);
    emitDm();
    expect(await pushed()).toBe(false);
  });

  it('does not push a sender an ignore rule hides', async () => {
    ignoreRulesService.add(userId, networkId, {
      mask: 'bob!*@*',
      channels: null,
      pattern: null,
      patternKind: 'substr',
      levels: ['ALL'],
      isExcept: false,
      expiresAt: null,
    });
    emitDm();
    expect(await pushed()).toBe(false);
  });

  it('does not push when a NONOTIFY rule matches', async () => {
    ignoreRulesService.add(userId, networkId, {
      mask: 'bob!*@*',
      channels: null,
      pattern: null,
      patternKind: 'substr',
      levels: ['NONOTIFY'],
      isExcept: false,
      expiresAt: null,
    });
    emitDm();
    expect(await pushed()).toBe(false);
  });

  it('DOES push when only a NOHIGHLIGHT rule matches', async () => {
    // Deliberate (#359): NOHIGHLIGHT means "don't light it up", not "don't tell
    // me". Only NONOTIFY freezes push. If this flips, the two levels have been
    // conflated.
    ignoreRulesService.add(userId, networkId, {
      mask: 'bob!*@*',
      channels: null,
      pattern: null,
      patternKind: 'substr',
      levels: ['NOHIGHLIGHT'],
      isExcept: false,
      expiresAt: null,
    });
    emitDm();
    expect(await pushed()).toBe(true);
  });

  it('does not push a DM when the DM toggle is off', async () => {
    setUserSetting(userId, 'notifications.dm.enabled', false);
    emitDm();
    expect(await pushed()).toBe(false);
  });

  it('does not push a highlight when the highlight toggle is off', async () => {
    setUserSetting(userId, 'notifications.highlight.enabled', false);
    emitChannel({ matched: true });
    expect(await pushed()).toBe(false);
  });

  it('gates a matched DM on the DM toggle, not the highlight toggle', async () => {
    // Kind priority: dm > matched > always_notify. A DM that also matched a rule
    // delivers as one 'dm' notification, so the highlight toggle must not
    // silence it and the DM toggle must.
    setUserSetting(userId, 'notifications.highlight.enabled', false);
    emitDm({ matched: true });
    expect(await pushed()).toBe(true);
    expect((await payload()).kind).toBe('dm');

    deliverMock = freshDeliver();
    setUserSetting(userId, 'notifications.dm.enabled', false);
    emitDm({ matched: true });
    expect(await pushed()).toBe(false);
  });

  it('does not push during a manual /away when mute_when_away is on', async () => {
    setUserSetting(userId, 'notifications.push.mute_when_away', true);
    writeAwayMarker(userId, { awayDatetime: new Date().toISOString(), autoSet: false });
    emitDm();
    expect(await pushed()).toBe(false);
  });

  it('DOES push during an AUTO away even when mute_when_away is on', async () => {
    // Deliberate: auto-away means the user walked off, which is precisely when
    // push matters most. Only a manual /away means "leave me alone".
    setUserSetting(userId, 'notifications.push.mute_when_away', true);
    writeAwayMarker(userId, { awayDatetime: new Date().toISOString(), autoSet: true });
    emitDm();
    expect(await pushed()).toBe(true);
  });

  it('pushes during a manual /away when mute_when_away is off', async () => {
    writeAwayMarker(userId, { awayDatetime: new Date().toISOString(), autoSet: false });
    emitDm();
    expect(await pushed()).toBe(true);
  });

  it('does not push inside the quiet-hours window', async () => {
    // Anchored to the user's timezone, so pin one and build a window that
    // brackets "now" in it rather than in the test runner's zone.
    setUserSetting(userId, 'system.timezone', 'UTC');
    const nowUtcMin = nowUtcMinutes();
    setUserSetting(userId, 'notifications.push.quiet_hours.enabled', true);
    setUserSetting(userId, 'notifications.push.quiet_hours.start', hhmm(nowUtcMin - 60));
    setUserSetting(userId, 'notifications.push.quiet_hours.end', hhmm(nowUtcMin + 60));
    emitDm();
    expect(await pushed()).toBe(false);
  });

  it('pushes outside the quiet-hours window', async () => {
    setUserSetting(userId, 'system.timezone', 'UTC');
    const nowUtcMin = nowUtcMinutes();
    setUserSetting(userId, 'notifications.push.quiet_hours.enabled', true);
    setUserSetting(userId, 'notifications.push.quiet_hours.start', hhmm(nowUtcMin + 120));
    setUserSetting(userId, 'notifications.push.quiet_hours.end', hhmm(nowUtcMin + 240));
    emitDm();
    expect(await pushed()).toBe(true);
  });

  it('pushes a notify_always channel message, gated by its own toggle', async () => {
    setChannelNotifyAlways(userId, networkId, '#lurker', true);
    try {
      emitChannel();
      expect(await pushed()).toBe(true);
      expect((await payload()).kind).toBe('always_notify');

      deliverMock = freshDeliver();
      setUserSetting(userId, 'notifications.always_notify.enabled', false);
      emitChannel();
      expect(await pushed()).toBe(false);
    } finally {
      setChannelNotifyAlways(userId, networkId, '#lurker', false);
    }
  });
});

// The payload is the contract across the pushService seam. Native transports
// must compose an APNs/FCM notification from exactly these fields, so pin the
// shape: a field silently dropped here is a notification that renders wrong on
// a device, with nothing else failing.
describe('maybePush payload', () => {
  it('carries the fields a notification is built from', async () => {
    const time = new Date().toISOString();
    emitDm({ text: 'hey there', time, id: 4242 });
    const p = await payload();
    expect(p).toMatchObject({
      kind: 'dm',
      networkId,
      target: 'bob',
      nick: 'bob',
      text: 'hey there',
      time,
      messageId: 4242,
    });
  });

  it('falls back to a synthetic network name when the connection is offline', async () => {
    // No live IrcConnection in tests, so this is the fallback branch. Worth
    // pinning: it's what a native notification title would show.
    emitDm();
    expect((await payload()).networkName).toBe(`net:${networkId}`);
  });

  it('stamps the unread-highlight total as the app-icon badge', async () => {
    // The badge is the running total, not this message's count (#451), and it
    // includes the triggering message because it is persisted before the push.
    buffers.ensureExists(userId, networkId, 'carol'); // the live filter's row-minting
    insertMessage({
      networkId,
      target: 'carol',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'carol',
      text: 'unread dm',
      self: false,
    });
    emitDm();
    // A DM's every unread line counts as a highlight, so the badge is non-zero
    // and reflects a DB scan rather than anything on the event.
    expect((await payload()).badge).toBeGreaterThan(0);
  });
});
