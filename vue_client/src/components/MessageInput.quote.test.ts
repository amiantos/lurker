// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The composer's side of Quote (#1119), through the real component: the quoted
// line lands above the draft with the caret under it, and the two-line send it
// makes goes out without the split confirmation — which a line torn by word
// wrap still gets.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useToastsStore } from '../stores/toasts.js';
import { useRepliesStore } from '../stores/replies.js';
import {
  addressNick,
  cancelComposerReply,
  focusComposer,
  quoteInComposer,
} from '../composables/useComposerOverlay.js';
import { useComposing } from '../composables/useComposing.js';
import { socketSendWithAck } from '../composables/useSocket.js';
import MessageInput from './MessageInput.vue';

type AckResult = { ok: boolean; error?: string };

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => void>(),
  socketSendWithAck: vi.fn<() => Promise<AckResult> | null>(() => Promise.resolve({ ok: true })),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const KEY = '1::#chan';
const ALICE = { nick: 'alice', type: 'message', text: 'what time is it?' };
const BOB = { nick: 'bob', type: 'message', text: 'three' };
const QUOTE = '> <alice> what time is it?';

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
  vi
    .mocked(socketSendWithAck)
    .mock.calls.map((c) => c[0] as Record<string, unknown>)
    // A draft's saves ride the same path; these are the lines sent.
    .filter((f) => !String(f.type).startsWith('draft-'));

describe('quoting a line', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSendWithAck).mockClear();
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('puts the quote above the draft, on its own line, with the caret at the end', async () => {
    seed();
    const el = await composer();
    await type(el, 'noon');
    quoteInComposer(ALICE);
    await flush();
    expect(el.value).toBe(`${QUOTE}\nnoon`);
    expect(el.selectionStart).toBe(el.value.length);
    expect(document.activeElement).toBe(el);
  });

  it('opens an empty draft as the quote and a fresh line under it', async () => {
    seed();
    const el = await composer();
    quoteInComposer(ALICE);
    await flush();
    expect(el.value).toBe(`${QUOTE}\n`);
    // The SPLIT chip already says what the send will be.
    expect(useComposing().chunks).toBe(1);
  });

  it('puts a second quote under the first, above the answer', async () => {
    seed();
    const el = await composer();
    quoteInComposer(ALICE);
    await flush();
    await type(el, `${QUOTE}\nboth of you`);
    quoteInComposer(BOB);
    await flush();
    expect(el.value).toBe(`${QUOTE}\n> <bob> three\nboth of you`);
  });

  it('clips the quote to one wire line', async () => {
    seed();
    const el = await composer();
    quoteInComposer({ ...ALICE, text: 'x'.repeat(900) });
    await flush();
    const [line, rest] = el.value.split('\n');
    expect(rest).toBe('');
    expect(line).toMatch(/^> <alice> x+…$/);
    expect(useComposing().chunks).toBe(1);
  });

  // One send carries one reply tag, and the server puts it on the first wire
  // line — which would be the quote. So Quote replaces a pending Reply, along
  // with the `nick: ` the Reply put in the draft.
  it('drops a pending Reply and the address it put in', async () => {
    seed();
    const el = await composer();
    useRepliesStore().start(KEY, { messageId: 42, ...ALICE });
    addressNick('alice');
    await flush();
    expect(el.value).toBe('alice: ');
    quoteInComposer(BOB);
    await flush();
    expect(el.value).toBe('> <bob> three\n');
    expect(useRepliesStore().forKey(KEY)).toBeNull();
    await type(el, '> <bob> three\nyes');
    await press(el, 'Enter');
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).not.toHaveProperty('replyTo');
  });

  it('leaves an address the user typed when it drops the Reply', async () => {
    seed();
    const el = await composer();
    await type(el, 'alice: ');
    useRepliesStore().start(KEY, { messageId: 42, ...ALICE });
    addressNick('alice'); // already addressed: nothing inserted, nothing to take back
    await flush();
    quoteInComposer(BOB);
    await flush();
    expect(el.value).toBe('> <bob> three\nalice: ');
    expect(useRepliesStore().forKey(KEY)).toBeNull();
  });

  // A Reply after a Quote is its plain-text half only: it addresses the answer,
  // not the quote line, and the reply tag — which would ride the quote line —
  // is dropped. The address stays as one the user typed.
  it('lets a Reply address the answer under the quote, without the tag', async () => {
    seed();
    const el = await composer();
    quoteInComposer(ALICE);
    await flush();
    await type(el, `${QUOTE}\nsure`);
    useRepliesStore().start(KEY, { messageId: 43, ...BOB });
    addressNick('bob');
    await flush();
    expect(el.value).toBe(`${QUOTE}\nbob: sure`);
    expect(useRepliesStore().forKey(KEY)).toBeNull();
    cancelComposerReply();
    await flush();
    expect(el.value).toBe(`${QUOTE}\nbob: sure`);
    await press(el, 'Enter');
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).not.toHaveProperty('replyTo');
  });

  it('drops the tag of a Reply to your own line under a quote too', async () => {
    seed();
    const el = await composer();
    quoteInComposer(ALICE);
    await flush();
    useRepliesStore().start(KEY, {
      messageId: 44,
      nick: 'me',
      type: 'message',
      text: 'x',
      self: true,
    });
    focusComposer();
    await flush();
    expect(useRepliesStore().forKey(KEY)).toBeNull();
    expect(el.value).toBe(`${QUOTE}\n`);
  });

  it('refuses to send a /command typed under a quote, which would go out as text', async () => {
    seed();
    const el = await composer();
    quoteInComposer(ALICE);
    await flush();
    await type(el, `${QUOTE}\n/msg bob the password is hunter2`);
    await press(el, 'Enter');
    expect(sent()).toEqual([]);
    expect(el.value).toBe(`${QUOTE}\n/msg bob the password is hunter2`);
    expect(useToastsStore().items.map((t) => t.title)).toEqual([
      "A /command can't go under a quote",
    ]);
  });

  it('sends a quote of a spoiler still hidden', async () => {
    seed();
    const el = await composer();
    quoteInComposer({ ...ALICE, text: 'the killer is \x0314,14bob\x03' });
    await flush();
    expect(el.value).toBe('> <alice> the killer is ||bob||\n');
    await type(el, `${el.value}knew it`);
    await press(el, 'Enter');
    expect(sent()[0].text).toBe('> <alice> the killer is \x0314,14bob\x03\nknew it');
  });

  it('refuses to quote above a /command, which would go out as text', async () => {
    seed();
    const el = await composer();
    await type(el, '/msg bob the password is hunter2');
    quoteInComposer(ALICE);
    await flush();
    expect(el.value).toBe('/msg bob the password is hunter2');
    expect(useToastsStore().items.map((t) => t.title)).toEqual(['Clear the /command first']);
    // An escaped slash is text, and takes a quote; one slash goes out, as at
    // the top of a draft.
    await type(el, '//me is not a command');
    quoteInComposer(ALICE);
    await flush();
    expect(el.value).toBe(`${QUOTE}\n//me is not a command`);
    await press(el, 'Enter');
    expect(sent()[0].text).toBe(`${QUOTE}\n/me is not a command`);
  });

  it('sends the quote and the answer as two typed lines without asking', async () => {
    seed();
    const el = await composer();
    await type(el, `${QUOTE}\nnoon`);
    expect(useComposing().chunks).toBe(2);
    expect(useComposing().typedLines).toBe(2);
    await press(el, 'Enter');
    expect(sent()).toEqual([
      expect.objectContaining({ type: 'send', target: '#chan', text: `${QUOTE}\nnoon` }),
    ]);
    expect(useToastsStore().items).toEqual([]);
    expect(el.value).toBe('');
  });

  it('still asks before sending one line torn in two by word wrap', async () => {
    seed();
    const el = await composer();
    await type(el, 'x'.repeat(600));
    expect(useComposing().chunks).toBe(2);
    expect(useComposing().typedLines).toBe(1);
    await press(el, 'Enter');
    expect(sent()).toEqual([]);
    expect(useToastsStore().items.map((t) => t.title)).toEqual([
      'Will split into 2 lines — Send again to confirm',
    ]);
    await press(el, 'Enter');
    expect(sent()).toHaveLength(1);
  });

  it('still offers the upload at three typed lines', async () => {
    seed();
    const el = await composer();
    await type(el, `${QUOTE}\n> <bob> three\nboth of you`);
    await press(el, 'Enter');
    expect(sent()).toEqual([]);
    // The modal, not the two-line toast.
    expect(useToastsStore().items).toEqual([]);
    expect(document.body.querySelector('pre.preview')?.textContent).toBe(
      `${QUOTE}\n> <bob> three\nboth of you`,
    );
  });
});
