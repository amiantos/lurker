// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// `/delete [reason]` (#1013): the most recent line you said here goes up as a
// `redact`, and every way it can't is said in the buffer.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useRedactionsStore } from '../stores/redactions.js';
import { useSettingsStore } from '../stores/settings.js';
import { socketSend } from '../composables/useSocket.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<{ ok: boolean }>>(() => Promise.resolve({ ok: true })),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const KEY = '1::#chan';
const T = '2026-11-05T00:00:00.000Z';
let mounted: VueWrapper[] = [];

function line(id: number, nick: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    networkId: 1,
    target: '#chan',
    type: 'message',
    nick,
    text,
    time: T,
    self: nick === 'me',
    ...extra,
  };
}

function seed(messages: Record<string, unknown>[], canRedact = true) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', canRedact } } as never;
  buffers.buffers[KEY] = { networkId: 1, target: '#chan', members: [], messages } as never;
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

async function run(el: HTMLTextAreaElement, command: string) {
  el.value = command;
  el.setSelectionRange(command.length, command.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  await flush();
}

const lastLocal = () => {
  const msgs = useBuffersStore().buffers[KEY]?.messages ?? [];
  return String((msgs[msgs.length - 1] as { text?: string })?.text ?? '');
};
const sentRedacts = () =>
  vi
    .mocked(socketSend)
    .mock.calls.map((c) => c[0])
    .filter((p) => p.type === 'redact');

describe('/delete', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('sends a redact for the last line you said, with the reason', async () => {
    seed([
      line(1, 'me', 'first', { msgid: 'm1' }),
      line(2, 'me', 'second', { msgid: 'm2' }),
      line(3, 'bob', 'theirs', { msgid: 'm3' }),
    ]);
    const el = await composer();
    await run(el, '/delete meant the other channel');
    expect(sentRedacts()).toEqual([
      { type: 'redact', messageId: 2, reason: 'meant the other channel' },
    ]);
  });

  it('sends no reason when none was given, and skips a line already deleted', async () => {
    seed([line(1, 'me', 'older', { msgid: 'm1' }), line(2, 'me', 'gone', { msgid: 'm2' })]);
    useRedactionsStore().byMessage.set(2, { by: 'me', time: T });
    const el = await composer();
    await run(el, '/delete');
    expect(sentRedacts()).toEqual([{ type: 'redact', messageId: 1 }]);
  });

  // A line fetched after the fact (#1283) is stored with a newer id than the
  // lines shown under it; the one to delete is the last one on screen.
  it('takes the last line shown, not the newest id', async () => {
    seed([
      line(1, 'me', 'said after the gap', { msgid: 'm1', time: '2026-11-05T00:10:00.000Z' }),
      line(2, 'me', 'filled in later', {
        msgid: 'm2',
        time: '2026-11-05T00:05:00.000Z',
        replay: true,
      }),
    ]);
    const el = await composer();
    await run(el, '/delete');
    expect(sentRedacts()).toEqual([{ type: 'redact', messageId: 1 }]);
  });

  // Rows the list hides are in the store all the same; a command typed at the
  // screen never lands on one.
  it('leaves a line above the /clear marker alone', async () => {
    seed([line(1, 'me', 'before the clear', { msgid: 'm1' }), line(2, 'bob', 'after')]);
    Object.assign(useBuffersStore().buffers[KEY]!, { clearedBeforeId: 1, clearedAt: T });
    const el = await composer();
    await run(el, '/delete');
    expect(sentRedacts()).toEqual([]);
    expect(lastLocal()).toContain('nothing of yours');
  });

  it('skips your reply that lives in a thread panel', async () => {
    seed([
      line(1, 'me', 'in the channel', { msgid: 'm1' }),
      line(2, 'me', 'in a thread', { msgid: 'm2', replyTo: { root: 'r0' } }),
    ]);
    Object.assign(useBuffersStore().buffers[KEY]!, { kind: 'channel' });
    useSettingsStore().values['chat.threads'] = true;
    const el = await composer();
    await run(el, '/delete');
    expect(sentRedacts()).toEqual([{ type: 'redact', messageId: 1 }]);
  });

  it('says so when the network cannot delete', async () => {
    seed([line(1, 'me', 'mine', { msgid: 'm1' })], false);
    const el = await composer();
    await run(el, '/delete');
    expect(sentRedacts()).toEqual([]);
    expect(lastLocal()).toContain("can't delete messages");
  });

  it('says so when nothing here is yours', async () => {
    seed([line(1, 'bob', 'theirs', { msgid: 'm1' })]);
    const el = await composer();
    await run(el, '/delete');
    expect(sentRedacts()).toEqual([]);
    expect(lastLocal()).toContain('nothing of yours');
  });

  it('says so when your line has no message id', async () => {
    seed([line(1, 'me', 'untagged')]);
    const el = await composer();
    await run(el, '/delete');
    expect(sentRedacts()).toEqual([]);
    expect(lastLocal()).toContain('no message id');
  });
});
