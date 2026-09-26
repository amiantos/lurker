// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The composer's side of IRCv3 replies (#993), through the real component: a
// pending reply rides the next chat line out as `replyTo` and is used up by it,
// a /me can be the reply, a send that never left gives it back, and Escape
// drops it along with the `nick: ` its Reply put in the draft.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useRepliesStore } from '../stores/replies.js';
import { addressNick, cancelComposerReply } from '../composables/useComposerOverlay.js';
import { socketSendWithAck } from '../composables/useSocket.js';
import MessageInput from './MessageInput.vue';

type AckResult = { ok: boolean; error?: string };

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => void>(),
  socketSendWithAck: vi.fn<() => Promise<AckResult> | null>(() => Promise.resolve({ ok: true })),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const KEY = '1::#chan';
const REPLY = Object.freeze({
  messageId: 42,
  nick: 'alice',
  type: 'message',
  text: 'what time is it?',
});

let mounted: VueWrapper[] = [];

function seed() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected' } } as never;
  buffers.buffers[KEY] = { networkId: 1, target: '#chan', members: [], messages: [] } as never;
  networks.activeKey = KEY;
  useRecentBuffersStore().keys = [KEY];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function composer(): Promise<HTMLTextAreaElement> {
  const wrapper = mount(MessageInput, { attachTo: document.body });
  mounted.push(wrapper);
  await flush();
  return wrapper.find('textarea').element as HTMLTextAreaElement;
}

async function type(el: HTMLTextAreaElement, value: string) {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

async function press(el: HTMLTextAreaElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  await flush();
  await flush();
}

const sent = () =>
  vi.mocked(socketSendWithAck).mock.calls.map((c) => c[0] as Record<string, unknown>);

// What a line's Reply action does (MessageList's onReply): start the pending
// reply, then have the composer address them.
async function reply(el: HTMLTextAreaElement) {
  useRepliesStore().start(KEY, REPLY);
  addressNick(REPLY.nick);
  await flush();
  return el;
}

describe('composing a reply', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSendWithAck).mockClear();
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('sends the next line as the reply, and uses the reply up', async () => {
    seed();
    useRepliesStore().start(KEY, REPLY);
    const el = await composer();
    await type(el, 'alice: noon');
    await press(el, 'Enter');
    expect(sent()).toEqual([
      expect.objectContaining({ type: 'send', target: '#chan', text: 'alice: noon', replyTo: 42 }),
    ]);
    expect(useRepliesStore().forKey(KEY)).toBeNull();

    // The line after it is an ordinary line.
    await type(el, 'and another thing');
    await press(el, 'Enter');
    expect(sent()[1]).not.toHaveProperty('replyTo');
  });

  it('makes a /me the reply', async () => {
    seed();
    useRepliesStore().start(KEY, REPLY);
    const el = await composer();
    await type(el, '/me checks the clock');
    await press(el, 'Enter');
    expect(sent()).toEqual([
      expect.objectContaining({ type: 'action', text: 'checks the clock', replyTo: 42 }),
    ]);
    expect(useRepliesStore().forKey(KEY)).toBeNull();
  });

  it('leaves the reply pending on an empty /me, which sends nothing', async () => {
    seed();
    useRepliesStore().start(KEY, REPLY);
    const el = await composer();
    await type(el, '/me');
    await press(el, 'Enter');
    expect(useRepliesStore().forKey(KEY)).toMatchObject(REPLY);
  });

  it('gives the reply back when the send never left', async () => {
    seed();
    useRepliesStore().start(KEY, REPLY);
    vi.mocked(socketSendWithAck).mockReturnValueOnce(null);
    const el = await composer();
    await type(el, 'alice: noon');
    await press(el, 'Enter');
    expect(useRepliesStore().forKey(KEY)).toMatchObject(REPLY);
  });

  it('gives it back when the server refuses the send', async () => {
    seed();
    useRepliesStore().start(KEY, REPLY);
    vi.mocked(socketSendWithAck).mockReturnValueOnce(
      Promise.resolve({ ok: false, error: 'not-connected' }),
    );
    const el = await composer();
    await type(el, 'alice: noon');
    await press(el, 'Enter');
    expect(useRepliesStore().forKey(KEY)).toMatchObject(REPLY);
  });

  it('gives a /me reply back when the server refuses it', async () => {
    seed();
    useRepliesStore().start(KEY, REPLY);
    vi.mocked(socketSendWithAck).mockReturnValueOnce(
      Promise.resolve({ ok: false, error: 'not-connected' }),
    );
    const el = await composer();
    await type(el, '/me checks the clock');
    await press(el, 'Enter');
    expect(useRepliesStore().forKey(KEY)).toMatchObject(REPLY);
  });

  it('drops the reply on Escape, and the address its Reply put in', async () => {
    seed();
    const el = await reply(await composer());
    expect(el.value).toBe('alice: ');
    await type(el, 'alice: it is noon');
    await press(el, 'Escape');
    expect(useRepliesStore().forKey(KEY)).toBeNull();
    expect(el.value).toBe('it is noon');
  });

  it('drops it from the status bar’s × the same way', async () => {
    seed();
    const el = await reply(await composer());
    await type(el, 'alice: it is noon');
    cancelComposerReply();
    await flush();
    expect(useRepliesStore().forKey(KEY)).toBeNull();
    expect(el.value).toBe('it is noon');
  });

  // An address the user typed is theirs: the Reply found it there and added
  // nothing, so cancelling has nothing to take back.
  it('leaves an address the user typed themselves', async () => {
    seed();
    const el = await composer();
    await type(el, 'alice: about earlier');
    await reply(el);
    expect(el.value).toBe('alice: about earlier');
    expect(useRepliesStore().forKey(KEY)?.addressed).toBeFalsy();
    await press(el, 'Escape');
    expect(useRepliesStore().forKey(KEY)).toBeNull();
    expect(el.value).toBe('alice: about earlier');
  });

  it('still takes back its own address after a second Reply to the same author', async () => {
    seed();
    const el = await reply(await composer());
    await reply(el);
    await type(el, 'alice: noon');
    await press(el, 'Escape');
    expect(el.value).toBe('noon');
  });

  it('leaves a draft that no longer addresses them alone', async () => {
    seed();
    const el = await reply(await composer());
    await type(el, 'alicia should know');
    await press(el, 'Escape');
    expect(useRepliesStore().forKey(KEY)).toBeNull();
    expect(el.value).toBe('alicia should know');
  });

  it('keeps each buffer’s reply to itself', async () => {
    seed();
    useRepliesStore().start('1::#other', REPLY);
    const el = await composer();
    await type(el, 'unrelated');
    await press(el, 'Enter');
    expect(sent()[0]).not.toHaveProperty('replyTo');
    expect(useRepliesStore().forKey('1::#other')).toMatchObject(REPLY);
  });
});
