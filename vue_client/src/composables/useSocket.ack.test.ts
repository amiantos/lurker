// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// socketSendWithAck for request-shaped messages (#727): get-mode-list answers
// on the send-result ACK with a `data` payload, and can wait on the IRC server
// longer than a send's 8 s.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useLinkPreview.js', () => ({
  primePreviews: vi.fn<(texts: unknown[], toggles: unknown) => void>(),
  previewRevision: { value: 0 },
}));

const sockets: FakeWebSocket[] = [];
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  listeners = new Map<string, Array<(ev: { data: string }) => void>>();
  constructor() {
    sockets.push(this);
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  close(): void {}
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }
  deliver(frame: Record<string, unknown>): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(frame) });
  }
}

import {
  onIrcEvent,
  useSocket,
  resetPreviewToggleWiring,
  resetSocket,
  socketSendWithAck,
} from './useSocket.js';

const RouteView = defineComponent({
  setup() {
    useSocket();
    return () => null;
  },
});

async function openSocket(): Promise<FakeWebSocket> {
  mount(RouteView);
  await nextTick();
  const ws = sockets.at(-1)!;
  ws.readyState = FakeWebSocket.OPEN;
  return ws;
}

describe('socketSendWithAck', () => {
  beforeEach(() => {
    resetSocket();
    sockets.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );
    setActivePinia(createPinia());
    resetPreviewToggleWiring();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetPreviewToggleWiring();
  });

  it("resolves with the ACK's data", async () => {
    const ws = await openSocket();
    const pending = socketSendWithAck({ type: 'get-mode-list', networkId: 1 })!;
    const clientId = ws.sent.at(-1)!.clientId;
    const entries = [{ mask: '*!*@bad', setBy: 'op', setAt: null }];
    ws.deliver({ kind: 'send-result', clientId, ok: true, data: { ok: true, entries } });
    await expect(pending).resolves.toEqual({
      ok: true,
      error: undefined,
      data: { ok: true, entries },
    });
  });

  it('waits as long as the caller says before timing out', async () => {
    const ws = await openSocket();
    vi.useFakeTimers();
    let settled: unknown = null;
    void socketSendWithAck({ type: 'get-mode-list' }, { timeoutMs: 35_000 })!.then(
      (r) => (settled = r),
    );
    await vi.advanceTimersByTimeAsync(8_001);
    expect(settled).toBeNull();
    const clientId = ws.sent.at(-1)!.clientId;
    ws.deliver({ kind: 'send-result', clientId, ok: false, error: 'no-reply', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toMatchObject({ ok: false, error: 'no-reply' });
  });

  it('onIrcEvent hears news, not a replay of a row its buffer already had', async () => {
    const ws = await openSocket();
    const heard: unknown[] = [];
    const stop = onIrcEvent((e) => heard.push(e.id));
    const frame = (id: number) => ({
      kind: 'irc',
      type: 'mode',
      networkId: 1,
      target: '#chan',
      id,
      modes: [],
    });
    ws.deliver(frame(500));
    ws.deliver(frame(500)); // the same row again, as a resume can send it
    ws.deliver(frame(499));
    ws.deliver(frame(501));
    // A lower id in ANOTHER buffer is still new to that buffer: replay is per buffer.
    ws.deliver({ ...frame(450), target: '#other' });
    stop();
    ws.deliver(frame(502));
    expect(heard).toEqual([500, 501, 450]);
  });

  it('onIrcEvent hears a resent chghost or channel invite only once', async () => {
    // Every row-bearing branch goes through the same replay test.
    const ws = await openSocket();
    const heard: unknown[] = [];
    const stop = onIrcEvent((e) => heard.push(`${e.type}:${e.id}`));
    const row = (type: string, id: number) => ({
      kind: 'irc',
      type,
      networkId: 1,
      target: '#chan',
      id,
      nick: 'bob',
    });
    for (const frame of [
      row('chghost', 600),
      row('chghost', 600),
      row('invite', 601),
      row('invite', 601),
    ]) {
      ws.deliver(frame);
    }
    stop();
    expect(heard).toEqual(['chghost:600', 'invite:601']);
  });

  it('still gives a plain send 8 s', async () => {
    await openSocket();
    vi.useFakeTimers();
    let settled: unknown = null;
    void socketSendWithAck({ type: 'send' })!.then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(8_001);
    expect(settled).toEqual({ ok: false, error: 'timeout' });
  });
});
