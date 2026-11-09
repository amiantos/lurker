// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// `/react <emoji|text>`: the most recent line someone else said here takes the
// reaction.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useRedactionsStore } from '../stores/redactions.js';
import { useIgnoresStore } from '../stores/ignores.js';
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

function seed(messages: Record<string, unknown>[]) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', canReact: true } } as never;
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
const sentReacts = () =>
  vi
    .mocked(socketSend)
    .mock.calls.map((c) => c[0])
    .filter((p) => p.type === 'react');

describe('/react', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('reacts to the last line someone else said', async () => {
    seed([
      line(1, 'bob', 'first', { msgid: 'm1' }),
      line(2, 'bob', 'second', { msgid: 'm2' }),
      line(3, 'me', 'mine', { msgid: 'm3' }),
    ]);
    const el = await composer();
    await run(el, '/react 👍');
    expect(sentReacts()).toEqual([{ type: 'react', messageId: 2, value: '👍', remove: false }]);
  });

  // A line fetched after the fact (#1283) is stored with a newer id than the
  // lines shown under it; the one to react to is the last one on screen.
  it('takes the last line shown, not the newest id', async () => {
    seed([
      line(1, 'bob', 'said after the gap', { msgid: 'm1', time: '2026-11-05T00:10:00.000Z' }),
      line(2, 'bob', 'filled in later', {
        msgid: 'm2',
        time: '2026-11-05T00:05:00.000Z',
        replay: true,
      }),
    ]);
    const el = await composer();
    await run(el, '/react 👍');
    expect(sentReacts()).toEqual([{ type: 'react', messageId: 1, value: '👍', remove: false }]);
  });

  // Rows the list hides are in the store all the same; a command typed at the
  // screen never lands on one.
  it('leaves a line above the /clear marker alone', async () => {
    seed([line(1, 'bob', 'before the clear', { msgid: 'm1' })]);
    Object.assign(useBuffersStore().buffers[KEY]!, { clearedBeforeId: 1, clearedAt: T });
    const el = await composer();
    await run(el, '/react 👍');
    expect(sentReacts()).toEqual([]);
    expect(lastLocal()).toContain('nothing here to react to');
  });

  it('skips a line from someone ignored', async () => {
    seed([line(1, 'bob', 'shown', { msgid: 'm1' }), line(2, 'mallory', 'hidden', { msgid: 'm2' })]);
    useIgnoresStore().global = [
      {
        id: 1,
        createdAt: '',
        mask: 'mallory!*@*',
        channels: null,
        pattern: null,
        patternKind: 'substr',
        levels: ['ALL'],
        isExcept: false,
        expiresAt: null,
      },
    ] as never;
    const el = await composer();
    await run(el, '/react 👍');
    expect(sentReacts()).toEqual([{ type: 'react', messageId: 1, value: '👍', remove: false }]);
  });

  it('skips a reply that lives in a thread panel', async () => {
    seed([
      line(1, 'bob', 'in the channel', { msgid: 'm1' }),
      line(2, 'carol', 'in a thread', { msgid: 'm2', replyTo: { root: 'r0' } }),
    ]);
    Object.assign(useBuffersStore().buffers[KEY]!, { kind: 'channel' });
    useSettingsStore().values['chat.threads'] = true;
    const el = await composer();
    await run(el, '/react 👍');
    expect(sentReacts()).toEqual([{ type: 'react', messageId: 1, value: '👍', remove: false }]);
  });

  // Not skipped: the last line is the deleted one, and reaching past it would
  // react to a line the user never meant.
  it('says so when the last line was deleted', async () => {
    seed([line(1, 'bob', 'older', { msgid: 'm1' }), line(2, 'bob', 'gone', { msgid: 'm2' })]);
    useRedactionsStore().byMessage.set(2, { by: 'bob', time: T });
    const el = await composer();
    await run(el, '/react 👍');
    expect(sentReacts()).toEqual([]);
    expect(lastLocal()).toContain("can't react to a deleted message");
  });
});
