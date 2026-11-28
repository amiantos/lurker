// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The thread panel's composer (#1225): what a send names and addresses, what
// it refuses, and Tab completion from the channel's members.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ThreadComposer from './ThreadComposer.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useThreadsStore } from '../stores/threads.js';
import type { ThreadMessage } from '../stores/threads.js';
import { useToastsStore } from '../stores/toasts.js';
import { useSettingsStore } from '../stores/settings.js';
import { socketSendWithAck } from '../composables/useSocket.js';
import { useUploadsStore, onInsertUrl } from '../stores/uploads.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<{ ok: boolean }>>(() => Promise.resolve({ ok: true })),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;

function line(id: number, over: Record<string, unknown> = {}): ThreadMessage {
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick: 'alice',
    text: `line ${id}`,
    msgid: `m${id}`,
    time: new Date(Date.UTC(2026, 9, 24, 12, id)).toISOString(),
    ...over,
  } as ThreadMessage;
}

function seed(target = '#chan', root: ThreadMessage | null = line(1)) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', canReply: true } } as never;
  const b = buffers.ensure(1, target, 9);
  b.members = [
    { nick: 'alice', modes: [], away: false },
    { nick: 'albert', modes: [], away: false },
  ];
  const threads = useThreadsStore();
  threads.open(9, 'm1');
  threads.applyThread({
    bufferId: 9,
    rootMsgid: 'm1',
    token: threads.view!.token,
    root: root ? { ...root, target } : null,
    replies: [line(2, { nick: 'bob', target, replyTo: { msgid: 'm1', root: 'm1', parent: null } })],
  });
  return threads;
}

async function type(text: string): Promise<HTMLTextAreaElement> {
  wrapper = mount(ThreadComposer, { attachTo: document.body });
  await wrapper.vm.$nextTick();
  const ta = wrapper.find('textarea');
  await ta.setValue(text);
  return ta.element as HTMLTextAreaElement;
}

const sends = () => vi.mocked(socketSendWithAck).mock.calls.map((c) => c[0]);

describe('ThreadComposer', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSendWithAck).mockClear();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('Enter answers the newest reply from someone else, addressed to them', async () => {
    seed();
    const ta = await type('me too');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()).toEqual([
      { type: 'send', networkId: 1, target: '#chan', text: 'bob: me too', replyTo: 2 },
    ]);
    await wrapper!.vm.$nextTick();
    expect(ta.value).toBe('');
  });

  it('with nobody else in it yet, answers the first line', async () => {
    const threads = seed();
    threads.view!.replies = [];
    await type('anyone?');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()[0]).toMatchObject({ text: 'alice: anyone?', replyTo: 1 });
  });

  it('no address on your own line or in a DM', async () => {
    const threads = seed('#chan', line(1, { nick: 'me', self: true }));
    threads.view!.replies = [];
    await type('to clarify');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()[0]).toMatchObject({ text: 'to clarify', replyTo: 1 });
    wrapper!.unmount();
    setActivePinia(createPinia());
    vi.mocked(socketSendWithAck).mockClear();
    seed('alice');
    await type('in a dm');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()[0]).toMatchObject({ target: 'alice', text: 'in a dm', replyTo: 2 });
  });

  it('refuses a /command with a toast; // escapes one slash', async () => {
    seed();
    await type('/msg bob secret');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()).toEqual([]);
    expect(useToastsStore().items.at(-1)?.title).toMatch(/Commands/);
    await wrapper!.find('textarea').setValue('//literal');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()[0]).toMatchObject({ text: 'bob: /literal' });
  });

  it('Tab completes a nick from the members, cycling on repeat', async () => {
    seed();
    const ta = await type('al');
    ta.setSelectionRange(2, 2);
    await wrapper!.find('textarea').trigger('keydown', { key: 'Tab' });
    expect(ta.value).toBe('alice: ');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Tab' });
    expect(ta.value).toBe('albert: ');
    // Mid-line: a bare nick and a space.
    await wrapper!.find('textarea').setValue('hey al');
    ta.setSelectionRange(6, 6);
    await wrapper!.find('textarea').trigger('keydown', { key: 'Tab' });
    expect(ta.value).toBe('hey alice ');
  });

  it('Tab offers your own nick last, wherever the member list holds it', async () => {
    seed();
    useBuffersStore()
      .ensure(1, '#chan', 9)
      .members.unshift({
        nick: 'alfie',
        modes: [],
        away: false,
      } as never);
    useNetworksStore().states[1]!.nick = 'alfie';
    const ta = await type('al');
    ta.setSelectionRange(2, 2);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await wrapper!.find('textarea').trigger('keydown', { key: 'Tab' });
      seen.push(ta.value);
    }
    expect(seen).toEqual(['alice: ', 'albert: ', 'alfie: ']);
  });

  it('Tab at the start of a line takes the channel’s completion suffix', async () => {
    seed();
    useSettingsStore().values['input.completion.nick_suffix'] = ',';
    const ta = await type('al');
    ta.setSelectionRange(2, 2);
    await wrapper!.find('textarea').trigger('keydown', { key: 'Tab' });
    expect(ta.value).toBe('alice, ');
  });

  it('refuses a line the network would split, since the rest would leave the thread', async () => {
    seed();
    await type('x'.repeat(600));
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()).toEqual([]);
    expect(useToastsStore().items.at(-1)?.title).toMatch(/Too long/);
    // A network with draft/multiline takes it as one batch under one tag.
    useNetworksStore().states[1] = {
      nick: 'me',
      state: 'connected',
      canReply: true,
      multilineLimits: { maxBytes: 4096, maxLines: 20 },
    } as never;
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()).toHaveLength(1);
  });

  it('sends to the buffer’s current name, not the one the thread opened under', async () => {
    const threads = seed('alice');
    // The peer changed nick: the buffer row follows, the open view does not.
    useBuffersStore().byId(9)!.target = 'alice_';
    expect(threads.view?.target).toBe('alice');
    await type('still you?');
    await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
    expect(sends()[0]).toMatchObject({ target: 'alice_', text: 'still you?' });
  });

  it('the Send button sends what Enter would, and is dead on an empty draft', async () => {
    seed();
    await type('');
    const btn = wrapper!.find('.send-btn');
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
    await wrapper!.find('textarea').setValue('by button');
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
    await btn.trigger('click');
    expect(sends()[0]).toMatchObject({ text: 'bob: by button', replyTo: 2 });
  });

  // A pasted file goes up and its URL lands in this reply, not in the
  // channel's draft; the send button is a spinner meanwhile.
  describe('a pasted file', () => {
    function paste(ta: HTMLTextAreaElement, file: File): Event {
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', {
        value: { items: [{ kind: 'file', getAsFile: () => file }] },
      });
      ta.dispatchEvent(ev);
      return ev;
    }
    const png = () => new File(['x'], 'shot.png', { type: 'image/png' });

    it('uploads it and puts the URL in the reply, not the channel draft', async () => {
      seed();
      const uploads = useUploadsStore();
      let finish!: (r: { url: string }) => void;
      const upload = vi
        .spyOn(uploads, 'upload')
        .mockImplementation(() => new Promise((r) => (finish = r)) as never);
      const channelDraft = vi.fn<(url: string) => void>();
      const unsub = onInsertUrl(channelDraft);
      try {
        const ta = await type('look');
        ta.setSelectionRange(4, 4);
        const ev = paste(ta, png());
        expect(ev.defaultPrevented).toBe(true);
        expect(upload).toHaveBeenCalledWith(expect.any(File), null, { insert: false });
        await wrapper!.vm.$nextTick();
        expect(wrapper!.find('.send-btn.uploading').exists()).toBe(true);
        finish({ url: 'https://x.test/shot.png' });
        await new Promise((r) => setTimeout(r, 0));
        expect(ta.value).toBe('look https://x.test/shot.png');
        expect(channelDraft).not.toHaveBeenCalled();
        expect(wrapper!.find('.send-btn.uploading').exists()).toBe(false);
      } finally {
        unsub();
      }
    });

    it('holds Enter until the file is up, and says where it went if the composer closes', async () => {
      seed();
      let finish!: (r: { url: string }) => void;
      vi.spyOn(useUploadsStore(), 'upload').mockImplementation(
        () => new Promise((r) => (finish = r)) as never,
      );
      const ta = await type('look');
      paste(ta, png());
      await wrapper!.find('textarea').trigger('keydown', { key: 'Enter' });
      expect(sends()).toEqual([]);
      wrapper!.unmount();
      wrapper = null;
      finish({ url: 'https://x.test/shot.png' });
      await new Promise((r) => setTimeout(r, 0));
      expect(useToastsStore().items.at(-1)).toMatchObject({ title: 'Uploaded' });
    });

    // A slow upload finishing into a composer the user went on using.
    describe('finishing while the user is busy', () => {
      let finish!: (r: { url: string }) => void;
      const settle = () => new Promise((r) => setTimeout(r, 0));
      beforeEach(() => {
        seed();
        vi.spyOn(useUploadsStore(), 'upload').mockImplementation(
          () => new Promise((r) => (finish = r)) as never,
        );
      });

      it('waits for an IME composition to end', async () => {
        const ta = await type('look');
        paste(ta, png());
        ta.dispatchEvent(new Event('compositionstart'));
        finish({ url: 'https://x.test/shot.png' });
        await settle();
        expect(ta.value).toBe('look');
        ta.dispatchEvent(new Event('compositionend'));
        await settle();
        expect(ta.value).toBe('look https://x.test/shot.png');
      });

      it('ends a Tab cycle, so the next Tab keeps the URL', async () => {
        const ta = await type('al');
        await wrapper!.find('textarea').trigger('keydown', { key: 'Tab' });
        expect(ta.value).toBe('alice: ');
        paste(ta, png());
        finish({ url: 'https://x.test/shot.png' });
        await settle();
        expect(ta.value).toBe('alice: https://x.test/shot.png');
        await wrapper!.find('textarea').trigger('keydown', { key: 'Tab' });
        expect(ta.value).toBe('alice: https://x.test/shot.png');
      });

      it('leaves focus where the user moved it', async () => {
        const elsewhere = document.createElement('input');
        document.body.append(elsewhere);
        try {
          const ta = await type('look');
          ta.focus();
          paste(ta, png());
          elsewhere.focus();
          finish({ url: 'https://x.test/shot.png' });
          await settle();
          expect(ta.value).toBe('look https://x.test/shot.png');
          expect(document.activeElement).toBe(elsewhere);
        } finally {
          elsewhere.remove();
        }
      });
    });

    it('says so when the upload fails', async () => {
      seed();
      vi.spyOn(useUploadsStore(), 'upload').mockRejectedValue(new Error('too big'));
      const ta = await type('');
      paste(ta, png());
      await new Promise((r) => setTimeout(r, 0));
      expect(useToastsStore().items.at(-1)).toMatchObject({
        title: 'Upload failed',
        body: 'too big',
      });
      expect(ta.value).toBe('');
    });

    it('leaves a paste alone when paste uploads are off', async () => {
      seed();
      useSettingsStore().values['uploads.paste.enabled'] = false;
      const upload = vi.spyOn(useUploadsStore(), 'upload');
      const ta = await type('');
      expect(paste(ta, png()).defaultPrevented).toBe(false);
      expect(upload).not.toHaveBeenCalled();
    });
  });

  it('is disabled while the network cannot carry a reply tag', async () => {
    seed();
    useNetworksStore().states[1] = { nick: 'me', state: 'connected', canReply: false } as never;
    await type('x');
    expect((wrapper!.find('textarea').element as HTMLTextAreaElement).disabled).toBe(true);
  });
});
