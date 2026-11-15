// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The thread panel (#1225) on its routes: what it asks for, what it draws for a
// thread (first line, count, replies, the quote only off the first line), the
// list mode, and the Reply pick that steers its composer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import ThreadPanel from './ThreadPanel.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useThreadsStore } from '../stores/threads.js';
import { useSettingsStore } from '../stores/settings.js';
import { useConfigStore } from '../stores/config.js';
import MessageBody from './MessageBody.vue';
import { previewRevision } from '../composables/useLinkPreview.js';
import type { ThreadMessage } from '../stores/threads.js';
import { socketSend } from '../composables/useSocket.js';
import * as threadNav from '../composables/useThreadNav.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<{ ok: boolean }>>(() => Promise.resolve({ ok: true })),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;
let router: Router;

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
    userhost: 'alice!~a@host',
    time: new Date(Date.UTC(2026, 9, 24, 12, id)).toISOString(),
    ...over,
  } as ThreadMessage;
}

function seed() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', canReply: true } } as never;
  const b = buffers.ensure(1, '#chan', 9);
  b.members = [{ nick: 'alice', modes: [], away: false }];
  networks.activeKey = '1::#chan';
}

async function mountAt(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/buffer/:id', name: 'buffer', component: { template: '<div />' } },
      {
        path: '/buffer/:id/thread/:root',
        name: 'buffer-thread',
        component: { template: '<div />' },
      },
      { path: '/buffer/:id/threads', name: 'buffer-threads', component: { template: '<div />' } },
    ],
  });
  await router.push(path);
  wrapper = mount(ThreadPanel, { attachTo: document.body, global: { plugins: [router] } });
  await wrapper.vm.$nextTick();
  return wrapper;
}

const sent = () => vi.mocked(socketSend).mock.calls.map((c) => c[0]);

describe('ThreadPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
  });

  it('asks for the thread its route names and draws it: first line, count, replies', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    expect(sent()[0]).toMatchObject({ type: 'thread', bufferId: 9, rootMsgid: 'm1' });
    expect(w.text()).toContain('loading thread');

    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: line(1, { text: 'anyone around?' }),
      replies: [
        line(2, {
          nick: 'bob',
          text: 'alice: here',
          replyTo: { msgid: 'm1', root: 'm1', parent: null },
        }),
        line(3, {
          nick: 'carol',
          text: 'bob: me too',
          replyTo: {
            msgid: 'm2',
            root: 'm1',
            parent: {
              id: 2,
              nick: 'bob',
              type: 'message',
              text: 'alice: here',
              userhost: null,
              self: false,
            },
          },
        }),
      ],
    });
    await w.vm.$nextTick();
    const rows = w.findAll('.t-line');
    expect(rows).toHaveLength(3);
    expect(rows[0].classes()).toContain('root');
    expect(rows[0].text()).toContain('anyone around?');
    expect(w.find('.rule').text()).toBe('2 replies');
    // The address the thread makes redundant is dropped; neither a reply to the
    // first line nor one to the line just above carries a quote (the quote test
    // below covers an answer to an earlier line).
    expect(rows[1].text()).toContain('here');
    expect(rows[1].text()).not.toContain('alice: here');
    expect(rows[1].find('.reply-quote').exists()).toBe(false);
    expect(rows[2].find('.reply-quote').exists()).toBe(false);

    // A live reply lands at the end.
    threads.applyLive(
      line(4, { nick: 'dave', replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
    );
    await w.vm.$nextTick();
    expect(w.findAll('.t-line')).toHaveLength(4);
    expect(w.find('.rule').text()).toBe('3 replies');
  });

  it('says so when the first line is gone, and offers neither Reply nor Quote on a line', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: null,
      replies: [line(2, { nick: 'bob', replyTo: { msgid: 'm1', root: 'm1', parent: null } })],
    });
    await w.vm.$nextTick();
    expect(w.find('.t-line.missing').text()).toContain('original message unavailable');
    // No status row and no paperclip: a textarea and Send.
    expect(w.find('.panel-status').exists()).toBe(false);
    expect(w.find('.thread-input .attach-btn').exists()).toBe(false);
    expect(w.find('.thread-input .send-btn').exists()).toBe(true);
    // A send from here answers the newest reply from someone else; picking a
    // line would undo that, and Quote would ride a send that carries a reply
    // tag. The rest of the bar is there.
    const titles = w.findAll('.row-action').map((b) => b.attributes('title') ?? '');
    expect(titles.some((t) => t.startsWith('Reply to'))).toBe(false);
    expect(titles.some((t) => t.startsWith('Quote'))).toBe(false);
    expect(titles).toContain('Copy text');
  });

  it('draws no reply quotes, even for an answer to an earlier line', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    const reply = (id: number, nick: string, to: string, text: string) =>
      line(id, {
        nick,
        text,
        replyTo: {
          msgid: to,
          root: 'm1',
          parent: {
            id: Number(to.slice(1)),
            nick: 'x',
            type: 'message',
            text,
            userhost: null,
            self: false,
          },
        },
      });
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: line(1),
      replies: [
        reply(2, 'bob', 'm1', 'to the first line'),
        reply(3, 'carol', 'm2', 'to the one just above'),
        reply(4, 'dave', 'm2', 'back to an earlier one'),
      ],
    });
    await w.vm.$nextTick();
    // No quotes anywhere: the thread's order is the context.
    expect(w.findAll('.reply-quote')).toHaveLength(0);
    expect(w.find('[data-msg-id="4"]').text()).toContain('back to an earlier one');
  });

  // The message list's gate (usePreviewBody): with previews on, a line with a
  // link goes through MessageBody (its media and cards); a plain line, a
  // notice, or any line with previews off stays plain text.
  it('unfurls links the way the message list does', async () => {
    seed();
    useConfigStore().features = { linkPreviews: true, bouncer: false, dcc: false };
    useSettingsStore().values['chat.inline_media.enabled'] = true;
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    const reply = (id: number, over: Record<string, unknown>) =>
      line(id, { nick: 'bob', replyTo: { msgid: 'm1', root: 'm1', parent: null }, ...over });
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: line(1),
      replies: [
        reply(2, { text: 'look https://x.test/cat.png' }),
        reply(3, { text: 'no link here' }),
        reply(4, { type: 'notice', text: 'bot https://x.test/a.png' }),
      ],
    });
    await w.vm.$nextTick();
    const unfurls = (id: number) =>
      w.find(`[data-msg-id="${id}"]`).findComponent(MessageBody).exists();
    expect(unfurls(2)).toBe(true);
    expect(unfurls(3)).toBe(false);
    expect(unfurls(4)).toBe(false);

    useSettingsStore().values['chat.inline_media.enabled'] = false;
    await w.vm.$nextTick();
    expect(unfurls(2)).toBe(false);
  });

  // A card lands after its line (previewRevision) and grows it: a reader at
  // the end stays there; a reply opened by name stays put until the reader
  // scrolls.
  describe('as previews fill in', () => {
    async function open(path: string) {
      seed();
      const w = await mountAt(path);
      const threads = useThreadsStore();
      threads.applyThread({
        bufferId: 9,
        rootMsgid: 'm1',
        token: threads.view!.token,
        root: line(1),
        replies: [2, 3].map((id) =>
          line(id, { replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
        ),
      });
      // Past the load's own scroll, which runs a tick later.
      await new Promise((r) => setTimeout(r, 0));
      const el = w.find('.lines').element as HTMLElement;
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 });
      // The height change's own scroll, which the resize guard takes in (a
      // browser's ResizeObserver would record it; happy-dom has none).
      await w.find('.lines').trigger('scroll');
      return { w, el };
    }
    const grow = async (el: HTMLElement, to: number) => {
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: to });
      previewRevision.value++;
      await new Promise((r) => setTimeout(r, 0));
    };

    it('keeps a reader at the end at the end', async () => {
      const { w, el } = await open('/buffer/9/thread/m1');
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 900 });
      el.scrollTop = 600;
      await w.find('.lines').trigger('scroll');
      await grow(el, 1200);
      expect(el.scrollTop).toBe(1200);
    });

    it('follows when previews are switched on, cards already cached', async () => {
      useConfigStore().features = { linkPreviews: true, bouncer: false, dcc: false };
      const { w, el } = await open('/buffer/9/thread/m1');
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 900 });
      el.scrollTop = 600;
      await w.find('.lines').trigger('scroll');
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1200 });
      useSettingsStore().values['chat.link_previews.enabled'] = true;
      await new Promise((r) => setTimeout(r, 0));
      expect(el.scrollTop).toBe(1200);
    });

    // Opened on a reply near the end: centring it lands at the bottom, and the
    // scroll event that comes of it (after the load) reads as "at the end". The
    // pin, not the tail, decides where growth below it leaves the reader.
    it('keeps a focused reply over the tail even when it sits at the end', async () => {
      const into = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
        this: HTMLElement,
      ) {
        const sc = this.closest('.lines') as HTMLElement | null;
        if (sc) sc.scrollTop = 600;
      });
      try {
        seed();
        const w = await mountAt('/buffer/9/thread/m1?focus=3');
        const el = w.find('.lines').element as HTMLElement;
        Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 });
        Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 900 });
        await w.find('.lines').trigger('scroll'); // the resize guard takes the height in
        const threads = useThreadsStore();
        threads.applyThread({
          bufferId: 9,
          rootMsgid: 'm1',
          token: threads.view!.token,
          root: line(1),
          replies: [2, 3].map((id) =>
            line(id, { replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
          ),
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(el.scrollTop).toBe(600);
        await w.find('.lines').trigger('scroll'); // centring's own scroll, at the end
        into.mockClear();
        await grow(el, 1200);
        expect(into).toHaveBeenCalledTimes(1);
        expect(el.scrollTop).toBe(600);
      } finally {
        into.mockRestore();
      }
    });

    it('holds a focused reply in place until the reader scrolls', async () => {
      const into = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
      try {
        const { w, el } = await open('/buffer/9/thread/m1?focus=3');
        into.mockClear();
        await grow(el, 1200);
        expect(into).toHaveBeenCalledTimes(1);
        expect((into.mock.contexts[0] as HTMLElement).dataset.msgId).toBe('3');

        el.scrollTop = 40;
        await w.find('.lines').trigger('scroll');
        into.mockClear();
        await grow(el, 1500);
        expect(into).not.toHaveBeenCalled();
      } finally {
        into.mockRestore();
      }
    });
  });

  // The composer grows up into the lines without moving scrollTop: a reader
  // at the end is kept there, one scrolled up is left where they are.
  it('keeps a reader at the end when the lines shrink', async () => {
    let fire: (() => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      seed();
      const w = await mountAt('/buffer/9/thread/m1');
      const threads = useThreadsStore();
      threads.applyThread({
        bufferId: 9,
        rootMsgid: 'm1',
        token: threads.view!.token,
        root: line(1),
        replies: [line(2, { replyTo: { msgid: 'm1', root: 'm1', parent: null } })],
      });
      // Past the load's own scroll to the end, which runs a tick later.
      await new Promise((r) => setTimeout(r, 0));
      const el = w.find('.lines').element as HTMLElement;
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 900 });
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 });
      el.scrollTop = 600;
      await w.find('.lines').trigger('scroll');
      // The shrink's own scroll event can come first, measured with the new
      // height and the old scrollTop: it mustn't drop the pin.
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 200 });
      await w.find('.lines').trigger('scroll');
      fire!();
      expect(el.scrollTop).toBe(900);

      el.scrollTop = 100;
      await w.find('.lines').trigger('scroll');
      fire!();
      expect(el.scrollTop).toBe(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rows are always the compact layout, whatever the list setting says', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    const at = (min: number) => new Date(Date.UTC(2026, 9, 24, 12, min)).toISOString();
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: line(1, { time: at(0) }),
      replies: [
        line(2, { nick: 'bob', time: at(1), replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
        line(3, { nick: 'bob', time: at(2), replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
        line(4, { nick: 'carol', time: at(3), replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
      ],
    });
    await w.vm.$nextTick();
    // Compact: a head per speaker run.
    expect(w.find('.lines').classes()).toContain('compact');
    expect(w.find('[data-msg-id="2"] .head').exists()).toBe(true);
    expect(w.find('[data-msg-id="3"] .head').exists()).toBe(false);
    expect(w.find('[data-msg-id="3"]').classes()).toContain('cont');
    expect(w.find('[data-msg-id="4"] .head').exists()).toBe(true);

    // The list's standard layout never fits the panel: still compact.
    useSettingsStore().values['look.message.layout'] = 'auto';
    await w.vm.$nextTick();
    expect(w.find('.lines').classes()).toContain('compact');
    expect(w.find('[data-msg-id="3"]').classes()).toContain('cont');
  });

  it('counts and tints by today’s rules: an ignored sender’s reply is out of the count', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const threads = useThreadsStore();
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'm1',
      token: threads.view!.token,
      root: line(1),
      replies: [
        line(2, { nick: 'bob', replyTo: { msgid: 'm1', root: 'm1', parent: null } }),
        line(3, {
          nick: 'troll',
          fromIgnored: true,
          replyTo: { msgid: 'm1', root: 'm1', parent: null },
        }),
        line(4, {
          nick: 'dave',
          matched: true,
          matchedRuleId: 1,
          replyTo: { msgid: 'm1', root: 'm1', parent: null },
        }),
        // An answer to you, opening with your nick: the shape of a thread, not
        // a highlight here (the server's stamps still badge the channel).
        line(5, {
          nick: 'erin',
          text: 'me: right back at you',
          matched: true,
          replyToSelf: true,
          replyTo: { msgid: 'm1', root: 'm1', parent: null },
        }),
      ],
    });
    await w.vm.$nextTick();
    expect(w.find('.rule').text()).toBe('3 replies');
    expect(w.find('[data-msg-id="3"]').text()).toContain('(ignored)');
    // A rule match tints (the stamp, until the rules are loaded).
    expect(w.find('[data-msg-id="4"]').classes()).toContain('highlight');
    expect(w.find('[data-msg-id="5"]').classes()).not.toContain('highlight');
  });

  it('the list route asks for the buffer’s threads and opens one on click', async () => {
    seed();
    const w = await mountAt('/buffer/9/threads');
    const threads = useThreadsStore();
    expect(sent()[0]).toMatchObject({ type: 'threads', bufferId: 9 });
    expect(w.find('.panel-title').text()).toBe('Threads');
    threads.applyList({
      bufferId: 9,
      token: threads.list!.token,
      threads: [
        {
          rootMsgid: 'm1',
          root: {
            id: 1,
            nick: 'alice',
            type: 'message',
            text: 'anyone?',
            userhost: null,
            self: false,
          },
          replies: 2,
          lastReplyId: 3,
          lastReplyTime: new Date().toISOString(),
        },
      ],
    });
    await w.vm.$nextTick();
    const row = w.find('.thread-list .row');
    expect(row.text()).toContain('anyone?');
    expect(row.text()).toContain('2 replies');
    const nav = vi.spyOn(threadNav, 'requestThreadNav');
    await row.trigger('click');
    expect(nav).toHaveBeenCalledWith({ kind: 'thread', bufferId: 9, rootMsgid: 'm1' });
  });

  it('× asks to close; the view goes with the panel', async () => {
    seed();
    const w = await mountAt('/buffer/9/thread/m1');
    const nav = vi.spyOn(threadNav, 'requestThreadNav');
    await w.find('.panel-head .close').trigger('click');
    expect(nav).toHaveBeenCalledWith({ kind: 'close', bufferId: 9 });
    w.unmount();
    wrapper = null;
    expect(useThreadsStore().view).toBeNull();
  });
});
