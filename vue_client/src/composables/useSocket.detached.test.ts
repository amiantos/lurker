// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// A detached buffer (the user is reading a history slice) drops live ROWS — but
// not the state they carry. pushMessage's `false` used to be read as "a replay"
// everywhere, so a detached channel's nicklist and topic froze until it
// reattached. A real replay must still change nothing.

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
  send(): void {}
  deliver(frame: Record<string, unknown>): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(frame) });
  }
}

import { useSocket, resetPreviewToggleWiring, resetSocket } from './useSocket.js';
import { useBuffersStore } from '../stores/buffers.js';

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

const irc = (id: number, fields: Record<string, unknown>) => ({
  kind: 'irc',
  networkId: 1,
  target: '#chan',
  id,
  time: '2026-09-23T12:00:00.000Z',
  ...fields,
});

function channel(detached: boolean) {
  const buffers = useBuffersStore();
  buffers.ensure(1, '#chan');
  buffers.setMembers(1, '#chan', [
    { nick: 'alice', modes: [], away: false },
    { nick: 'bob', modes: [], away: false },
  ]);
  buffers.setTopic(1, '#chan', 'old topic');
  buffers.buffers['1::#chan'].detached = detached;
  return buffers;
}
const nicks = (buffers: ReturnType<typeof useBuffersStore>) =>
  buffers.buffers['1::#chan'].members.map((m) => m.nick);

describe('live events on a detached buffer', () => {
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
    vi.unstubAllGlobals();
    resetPreviewToggleWiring();
  });

  it('keeps the nicklist and topic current while the rows stay out of the slice', async () => {
    const ws = await openSocket();
    const buffers = channel(true);
    ws.deliver(irc(10, { type: 'join', nick: 'carol' }));
    ws.deliver(irc(11, { type: 'part', nick: 'alice' }));
    ws.deliver(irc(12, { type: 'nick', nick: 'bob', newNick: 'robert' }));
    ws.deliver(irc(13, { type: 'topic', nick: 'carol', text: 'new topic' }));
    expect(nicks(buffers).toSorted()).toEqual(['carol', 'robert']);
    const buf = buffers.buffers['1::#chan'];
    expect(buf.topic).toBe('new topic');
    expect(buf.topicSetBy).toBe('carol');
    // Still detached: the rows themselves wait for the reattach.
    expect(buf.messages).toEqual([]);
    expect(buf.liveDuringDetach).toBe(4);
  });

  it("doesn't re-apply a replay of a row it already had", async () => {
    const ws = await openSocket();
    const buffers = channel(true);
    ws.deliver(irc(20, { type: 'part', nick: 'alice' }));
    ws.deliver(irc(21, { type: 'join', nick: 'alice' }));
    // A resume resends the part (id 20, already seen): alice stays, and the
    // "Return to present" badge doesn't count it as new activity.
    ws.deliver(irc(20, { type: 'part', nick: 'alice' }));
    expect(nicks(buffers)).toContain('alice');
    expect(buffers.buffers['1::#chan'].liveDuringDetach).toBe(2);
  });

  it('takes a row from before the jump as a replay, and the next one as news', async () => {
    const ws = await openSocket();
    const buffers = channel(false);
    buffers.pushMessage({ id: 50, networkId: 1, target: '#chan', type: 'message', nick: 'x' });
    // Jumping back records where the live tail was.
    buffers.detachForJump(1, '#chan');
    ws.deliver(irc(50, { type: 'part', nick: 'alice' }));
    expect(nicks(buffers)).toContain('alice');
    ws.deliver(irc(51, { type: 'part', nick: 'alice' }));
    expect(nicks(buffers)).not.toContain('alice');
  });

  it('finds the tail past a row with no id', async () => {
    // A local /commands line sits at the bottom with no id.
    const ws = await openSocket();
    const buffers = channel(false);
    buffers.pushMessage({ id: 50, networkId: 1, target: '#chan', type: 'message', nick: 'x' });
    buffers.pushMessage({ networkId: 1, target: '#chan', type: 'motd', body: '/commands …' });
    buffers.detachForJump(1, '#chan');
    ws.deliver(irc(50, { type: 'part', nick: 'alice' }));
    expect(nicks(buffers)).toContain('alice');
  });

  it('trusts its own tail over the cursor, so a row after a higher id elsewhere is news', async () => {
    const ws = await openSocket();
    const buffers = channel(false);
    buffers.pushMessage({ id: 50, networkId: 1, target: '#chan', type: 'message', nick: 'x' });
    // Another channel has moved the cursor to 100 …
    ws.deliver({ ...irc(100, { type: 'message', nick: 'z', text: 'hi' }), target: '#other' });
    buffers.detachForJump(1, '#chan');
    // … and #chan's own 60 arrives after it. Its tail is 50: news.
    ws.deliver(irc(60, { type: 'join', nick: 'carol' }));
    expect(nicks(buffers)).toContain('carol');
  });

  it("takes the socket's cursor as the floor when the buffer holds no rows", async () => {
    // A shell (or a buffer wiped on reconnect) has no tail of its own; every id
    // up to the cursor has already been delivered.
    const ws = await openSocket();
    const buffers = channel(false);
    ws.deliver({ ...irc(70, { type: 'message', nick: 'z', text: 'hi' }), target: '#other' });
    buffers.detachForJump(1, '#chan');
    ws.deliver(irc(60, { type: 'part', nick: 'alice' }));
    expect(nicks(buffers)).toContain('alice');
    ws.deliver(irc(71, { type: 'part', nick: 'alice' }));
    expect(nicks(buffers)).not.toContain('alice');
  });

  it("doesn't judge the system buffer by the network cursor", async () => {
    // System lines are numbered by their own sequence; a network cursor at 100
    // says nothing about system line 5.
    const ws = await openSocket();
    const buffers = useBuffersStore();
    ws.deliver({ ...irc(100, { type: 'message', nick: 'z', text: 'hi' }), target: '#other' });
    buffers.ensure(null as unknown as number, ':system:');
    buffers.detachForJump(null as unknown as number, ':system:');
    ws.deliver({
      kind: 'irc',
      type: 'system',
      networkId: null,
      target: ':system:',
      id: 5,
      text: 'x',
    });
    expect(buffers.buffers[':system:'].liveDuringDetach).toBe(1);
  });

  it('counts a backlog it dropped while detached as seen', async () => {
    const ws = await openSocket();
    const buffers = channel(true);
    buffers.replaceBacklog(
      1,
      '#chan',
      [{ id: 81, networkId: 1, target: '#chan', type: 'part', nick: 'alice' }],
      undefined,
      null,
      true,
    );
    // A live frame resending that same row is a replay, not news.
    ws.deliver(irc(81, { type: 'part', nick: 'alice' }));
    expect(nicks(buffers)).toContain('alice');
  });

  it("doesn't depend on other buffers' events arriving in id order", async () => {
    // Replay is judged per buffer: a higher id seen first elsewhere must not
    // make this channel's event look old.
    const ws = await openSocket();
    const buffers = channel(true);
    ws.deliver({ ...irc(101, { type: 'message', nick: 'z', text: 'hi' }), target: '#other' });
    ws.deliver(irc(100, { type: 'join', nick: 'carol' }));
    expect(nicks(buffers)).toContain('carol');
  });

  it("clears a speaker's typing indicator even though their row isn't drawn", async () => {
    const ws = await openSocket();
    const buffers = channel(true);
    buffers.setTyping(1, '#chan', 'bob', 'active');
    expect(buffers.buffers['1::#chan'].typing.bob).toBeDefined();
    ws.deliver(irc(40, { type: 'message', nick: 'bob', text: 'done typing' }));
    expect(buffers.buffers['1::#chan'].typing.bob).toBeUndefined();
  });

  it('still leaves a live-tail buffer to its own dedupe', async () => {
    const ws = await openSocket();
    const buffers = channel(false);
    ws.deliver(irc(30, { type: 'topic', nick: 'carol', text: 'live topic' }));
    expect(buffers.buffers['1::#chan'].topic).toBe('live topic');
    expect(buffers.buffers['1::#chan'].messages.map((m) => m.id)).toEqual([30]);
  });
});
