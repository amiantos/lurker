// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The thread view through a real router and the real store: it opens what the
// URL names, draws the tree the way tree(1) would, and `reply` on a line
// starts the reply and opens the composer's slot under it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory, useRoute, type Router } from 'vue-router';
import { defineComponent, h } from 'vue';
import ThreadView from './ThreadView.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useThreadsStore } from '../stores/threads.js';
import type { ThreadMessage } from '../stores/threads.js';
import { useRepliesStore } from '../stores/replies.js';
import { useSettingsStore } from '../stores/settings.js';
import { socketSend } from '../composables/useSocket.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;
let router: Router;

function line(id: number, nick: string, text: string, parent?: string): ThreadMessage {
  return {
    id,
    msgid: `m${id}`,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick,
    text,
    time: new Date(Date.UTC(2026, 8, 26, 14, id)).toISOString(),
    self: nick === 'me',
    ...(parent ? { replyTo: { msgid: parent, root: 'm1', parent: null } } : {}),
  } as ThreadMessage;
}

async function mountAt(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/buffer/:id', name: 'buffer', component: { template: '<div/>' } },
      {
        path: '/buffer/:id/thread/:root',
        name: 'buffer-thread',
        component: { template: '<div/>' },
      },
    ],
  });
  await router.push(path);
  wrapper = mount(ThreadView, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

// Answer the view's `thread` request.
async function answer(root: ThreadMessage | null, replies: ThreadMessage[]) {
  const ask = vi
    .mocked(socketSend)
    .mock.calls.map((c) => c[0] as Record<string, unknown>)
    .findLast((m) => m.type === 'thread')!;
  useThreadsStore().applyThread({
    bufferId: 9,
    rootMsgid: 'm1',
    token: ask.token as number,
    root,
    replies,
  });
  await flushPromises();
}

// Each line as tree(1) draws it, from the gutter's classes and the body text.
function drawn(w: VueWrapper): string[] {
  return w.findAll('.t-line:not(.t-compose)').map((row) => {
    const gutter = row
      .findAll('.g')
      .map((g) =>
        g.classes('rail') ? '│  ' : g.classes('tee') ? '├─ ' : g.classes('elbow') ? '└─ ' : '   ',
      )
      .join('');
    const body = row.find('.t-body');
    const text = body.find('.t-nick').exists()
      ? `${body.find('.t-nick').text()} ${body
          .text()
          .replace(body.find('.t-nick').text(), '')
          .replace(/reply$/, '')
          .trim()}`
      : body.text();
    return gutter + text;
  });
}

describe('ThreadView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    const networks = useNetworksStore();
    networks.networks = [{ id: 1, name: 'testnet' }] as never;
    networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
    useBuffersStore().ensure(1, '#chan', 9);
    networks.activeKey = '1::#chan';
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('opens the thread the URL names, and draws it as a tree', async () => {
    const w = await mountAt('/buffer/9/thread/m1');
    expect(useThreadsStore().view).toMatchObject({ bufferId: 9, rootMsgid: 'm1', loading: true });
    await answer(line(1, 'amiantos', 'blah blah blah'), [
      line(2, 'relyimah', 'amiantos: yadda yadda yadda', 'm1'),
      line(3, 'amiantos', 'i disagree', 'm2'),
      line(4, 'bradroot', 'I think that’s a great idea', 'm1'),
    ]);
    expect(drawn(w)).toEqual([
      '<amiantos> blah blah blah',
      '├─ <relyimah> amiantos: yadda yadda yadda',
      '│  └─ <amiantos> i disagree',
      '└─ <bradroot> I think that’s a great idea',
    ]);
  });

  it('keeps the replies’ shape under a stand-in when the first line is gone', async () => {
    const w = await mountAt('/buffer/9/thread/m1');
    await answer(null, [line(2, 'bob', 'still here', 'm1')]);
    expect(drawn(w)).toEqual(['original message unavailable', '└─ <bob> still here']);
  });

  it('Reply from the hover bar picks the line and marks it; the composer stays put', async () => {
    useSettingsStore().values = { 'look.message.hover_actions': true } as never;
    const w = await mountAt('/buffer/9/thread/m1');
    await answer(line(1, 'alice', 'question'), [
      line(2, 'bob', 'answer', 'm1'),
      line(3, 'carol', 'more', 'm1'),
    ]);
    const bar = w.find('[data-msg-id="2"] .row-actions');
    expect(bar.findAll('.row-action').map((b) => b.attributes('aria-label'))).toContain(
      'Reply to bob',
    );
    await bar.find('[aria-label="Reply to bob"]').trigger('click');

    expect(useRepliesStore().forKey('1::#chan')).toMatchObject({ messageId: 2, nick: 'bob' });
    expect(w.find('[data-msg-id="2"]').classes()).toContain('replying');
    expect(w.find('[data-msg-id="3"]').classes()).not.toContain('replying');
    // No composer of its own, and nothing moved into the view.
    expect(w.find('textarea').exists()).toBe(false);
  });

  it('puts a space between the nick and what they said', async () => {
    const w = await mountAt('/buffer/9/thread/m1');
    await answer(line(1, 'alice', 'question'), []);
    expect(w.find('[data-msg-id="1"] .t-body').text()).toMatch(/^<alice> question/);
  });

  it('reads a reply the server counts after it lands', async () => {
    await mountAt('/buffer/9/thread/m1');
    await answer(line(1, 'alice', 'question'), [line(2, 'bob', 'answer', 'm1')]);
    const followed = {
      networkId: 1,
      bufferId: 9,
      target: '#chan',
      rootMsgid: 'm1',
      name: null,
      root: null,
      highlighted: false,
      lastReplyId: 3,
      lastReplyTime: '',
    };
    useThreadsStore().applyFollowed([{ ...followed, unread: 0 }]);
    // The reply's `irc` frame first — nothing is unread yet, so nothing to read…
    useThreadsStore().applyLive(line(3, 'carol', 'late', 'm1'));
    await flushPromises();
    const reads = () =>
      vi
        .mocked(socketSend)
        .mock.calls.filter((c) => (c[0] as { type: string }).type === 'thread-read');
    expect(reads()).toHaveLength(0);
    // …then the `threads-changed` that counts it.
    useThreadsStore().applyFollowed([{ ...followed, unread: 1 }]);
    await flushPromises();
    expect(reads().at(-1)?.[0]).toMatchObject({ type: 'thread-read', messageId: 3 });
  });

  it('back on the channel’s lines, reads what arrived while the thread was up', async () => {
    const activate = vi.spyOn(useBuffersStore(), 'activate');
    // As the shell does it: the route takes the view down.
    const Shell = defineComponent({
      setup() {
        const route = useRoute();
        return () => (route.name === 'buffer-thread' ? h(ThreadView) : null);
      },
    });
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/buffer/:id', name: 'buffer', component: Shell },
        { path: '/buffer/:id/thread/:root', name: 'buffer-thread', component: Shell },
        { path: '/buffer/:id/members', name: 'buffer-members', component: Shell },
      ],
    });
    await router.push('/buffer/9/thread/m1');
    wrapper = mount(Shell, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();

    // To somewhere else first: nothing read.
    await router.push('/buffer/9/members');
    await flushPromises();
    expect(activate).not.toHaveBeenCalled();

    await router.push('/buffer/9/thread/m1');
    await flushPromises();
    await router.push('/buffer/9');
    await flushPromises();
    expect(activate).toHaveBeenCalledWith(1, '#chan');
  });

  it('closes the view when it goes', async () => {
    const w = await mountAt('/buffer/9/thread/m1');
    w.unmount();
    wrapper = null;
    expect(useThreadsStore().view).toBeNull();
  });
});
