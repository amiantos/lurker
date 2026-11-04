// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The relay checkbox flips itself before the change is confirmed or saved, and
// Vue can't put it back because the bound value never moved. A cancelled or
// failed change must leave it showing the truth.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import { useAdminStore, type AdminPushConfig } from '../../stores/admin.js';
import NotificationsPane from './NotificationsPane.vue';

function config(
  over: Partial<AdminPushConfig['relay']> = {},
  transports = ['webpush'],
  appleAccepts = true,
) {
  return {
    publicKey: 'BPubKeyBase64url',
    vapidSubject: { subject: 'https://lurker.example.com', appleAccepts, ignored: null },
    transports,
    relay: { url: 'https://push.lurker.chat', enabled: false, devices: 0, status: null, ...over },
  } satisfies AdminPushConfig;
}

let setRelay: ReturnType<typeof vi.fn<(enabled: boolean) => Promise<number>>>;

function stubConfirm(answer: boolean) {
  const fn = vi.fn<(message?: string) => boolean>(() => answer);
  window.confirm = fn as unknown as typeof window.confirm;
  return fn;
}

let refreshStatus: ReturnType<typeof vi.fn<() => Promise<void>>>;

async function mountPane(initial: AdminPushConfig): Promise<VueWrapper> {
  const store = useAdminStore();
  store.fetchPush = vi.fn<() => Promise<void>>(async () => {
    store.push = initial;
    store.relayStatus = initial.relay.status; // the store seeds it from the GET
  });
  refreshStatus = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  store.refreshRelayStatus = refreshStatus as unknown as typeof store.refreshRelayStatus;
  setRelay = vi.fn<(enabled: boolean) => Promise<number>>().mockResolvedValue(0);
  store.setPushRelayEnabled = setRelay as unknown as typeof store.setPushRelayEnabled;
  // The pane also loads the push log and the connected clients (#1272); neither
  // is this file's subject, and neither may reach for a server.
  store.fetchPushLog = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  store.fetchPresence = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const wrapper = mount(NotificationsPane);
  await flushPromises();
  return wrapper;
}

function checkbox(wrapper: VueWrapper): HTMLInputElement {
  return wrapper.find('input[type="checkbox"]').element as HTMLInputElement;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('NotificationsPane', () => {
  it('shows the key to register and no relay talk on a server with native push', async () => {
    const w = await mountPane(config({}, ['webpush', 'apns', 'fcm']));
    expect(w.find('input[type="checkbox"]').exists()).toBe(false);
    expect(w.text()).toContain('directly');
  });

  it('keeps the toggle on a native server while the relay is on, so it can be turned off', async () => {
    const w = await mountPane(config({ enabled: true, devices: 1 }, ['webpush', 'apns', 'fcm']));
    expect(checkbox(w).checked).toBe(true);
  });

  it("warns when Safari will refuse this server's pushes, without blaming the apps", async () => {
    const quiet = await mountPane(config());
    expect(quiet.text()).not.toContain('will refuse');
    const w = await mountPane(config({}, ['webpush'], false));
    expect(w.text()).toContain('Safari and home-screen web apps on iPhone will refuse');
    expect(w.text()).toContain("Lurker apps aren't affected");
    expect(w.text()).toContain('VAPID_SUBJECT');
  });

  it('says when VAPID_SUBJECT was set but not used', async () => {
    const c: AdminPushConfig = config();
    c.vapidSubject = {
      subject: 'https://chat.lurker.chat',
      appleAccepts: true,
      ignored: 'mailto:',
    };
    const w = await mountPane(c);
    expect(w.text()).toContain("VAPID_SUBJECT isn't usable");
    expect(w.text()).toContain('https://chat.lurker.chat');
  });

  it('shows the server key on a self-hosted server', async () => {
    const w = await mountPane(config());
    expect(w.find('code.key').text()).toBe('BPubKeyBase64url');
    expect(checkbox(w).checked).toBe(false);
  });

  it('turns the relay on without asking', async () => {
    const confirm = stubConfirm(true);
    const w = await mountPane(config());
    await w.find('input[type="checkbox"]').setValue(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(setRelay).toHaveBeenCalledWith(true);
  });

  it('asks before turning off a relay devices depend on, and stays on if cancelled', async () => {
    const confirm = stubConfirm(false);
    const w = await mountPane(config({ enabled: true, devices: 3 }));
    await w.find('input[type="checkbox"]').setValue(false);
    expect(confirm.mock.calls[0][0]).toContain('3 devices');
    expect(setRelay).not.toHaveBeenCalled();
    expect(checkbox(w).checked).toBe(true);
  });

  it('puts the checkbox back when the save fails', async () => {
    stubConfirm(true);
    const w = await mountPane(config());
    setRelay.mockRejectedValueOnce(new Error('nope'));
    await w.find('input[type="checkbox"]').setValue(true);
    await flushPromises();
    expect(checkbox(w).checked).toBe(false);
    expect(w.text()).toContain('nope');
  });

  it.each([
    [{ state: 'active', comped: true, paidThrough: null }, 'Comped'],
    [
      // The plan's example: the UTC calendar date, whatever the browser's zone.
      { state: 'active', comped: false, paidThrough: '2027-10-06T00:00:00Z' },
      'Active — paid through 2027-10-06',
    ],
    [
      { state: 'inactive', registered: false },
      "push.lurker.chat doesn't recognize this server's key",
    ],
    [{ state: 'inactive', registered: true }, "This server's key isn't active on push.lurker.chat"],
    [{ state: 'unauthorized' }, "push.lurker.chat couldn't verify this server's key"],
    [{ state: 'refused', httpStatus: 404 }, 'push.lurker.chat refused the status check (HTTP 404)'],
    [{ state: 'unreachable', reason: 'x' }, "Couldn't reach push.lurker.chat"],
  ] as const)('shows what the relay said: %j', async (status, text) => {
    const w = await mountPane(config({ status }));
    expect(w.find('.relay-status').text()).toContain(text);
  });

  it('says nothing about the relay until asked, and asks on "check"', async () => {
    const w = await mountPane(config());
    expect(w.find('.relay-status').text()).not.toContain('push.lurker.chat');
    const store = useAdminStore();
    const checkPushRelay = vi.fn<() => Promise<void>>(async () => {
      store.relayStatus = { state: 'active', comped: true, paidThrough: null };
    });
    store.checkPushRelay = checkPushRelay as unknown as typeof store.checkPushRelay;
    await w.find('.relay-status button').trigger('click');
    await flushPromises();
    expect(checkPushRelay).toHaveBeenCalledOnce();
    expect(w.find('.relay-status').text()).toContain('Comped');
  });

  it('shows why turning on was refused once, in the status line, and leaves the box unchecked', async () => {
    stubConfirm(true);
    const w = await mountPane(config());
    const store = useAdminStore();
    // The store keeps the refusal's answer (see admin.test.ts) and rethrows the 409.
    setRelay.mockImplementationOnce(async () => {
      store.relayStatus = { state: 'inactive', registered: false };
      throw Object.assign(new Error('Conflict'), { status: 409 });
    });
    await w.find('input[type="checkbox"]').setValue(true);
    await flushPromises();
    expect(checkbox(w).checked).toBe(false);
    expect(w.find('.relay-status').text()).toContain("doesn't recognize this server's key");
    expect(w.text()).not.toContain('Conflict');
    expect(w.text().split("doesn't recognize").length - 1).toBe(1);
  });

  it("can't check while a toggle is saving", async () => {
    stubConfirm(true);
    const w = await mountPane(config());
    let finish!: () => void;
    setRelay.mockImplementationOnce(() => new Promise<number>((r) => (finish = () => r(0))));
    await w.find('input[type="checkbox"]').setValue(true);
    expect(w.find('.relay-status button').attributes('disabled')).toBeDefined();
    finish();
    await flushPromises();
    expect(w.find('.relay-status button').attributes('disabled')).toBeUndefined();
  });

  it('asks for the status after loading, and shows what arrives — only while opted in', async () => {
    const off = await mountPane(config());
    expect(refreshStatus).not.toHaveBeenCalled();
    off.unmount();

    const w = await mountPane(config({ enabled: true, devices: 1 }));
    expect(refreshStatus).toHaveBeenCalledOnce();
    expect(w.find('.relay-status').text()).not.toContain('Comped');
    // The background refresh lands after mount.
    useAdminStore().relayStatus = { state: 'active', comped: true, paidThrough: null };
    await flushPromises();
    expect(w.find('.relay-status').text()).toContain('Comped');
  });
});
