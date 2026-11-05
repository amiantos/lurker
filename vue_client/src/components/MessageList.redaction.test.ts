// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A deleted line in the timeline (#1013): the placeholder where its words were,
// on a row read back that way and on one deleted while on screen; its reactions
// gone with it; its quote in a reply reading as deleted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useReactionsStore } from '../stores/reactions.js';
import { useRedactionsStore } from '../stores/redactions.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;
let nextId = 1;
const T = '2026-11-05T00:00:00.000Z';

function line(nick: string, text: string, extra: Record<string, unknown> = {}) {
  const id = nextId++;
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick,
    text,
    userhost: `${nick}!~u@host`,
    time: new Date(Date.UTC(2026, 10, 5, 12, id)).toISOString(),
    self: nick === 'me',
    msgid: `m${id}`,
    ...extra,
  };
}

function mountWith(messages: Record<string, unknown>[]) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = buffers.ensure(1, '#chan', 9);
  b.messages = messages as never;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
  return wrapper;
}

const rowOf = (w: VueWrapper, id: number) => w.find(`[data-msg-id="${id}"]`);

describe('MessageList — deleted lines', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    nextId = 1;
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('shows the placeholder for a line read back as deleted, naming an op and the reason', () => {
    const gone = line('bob', null as never, { redaction: { by: 'opal', reason: 'spam', time: T } });
    const own = line('bob', null as never, { redaction: { by: 'bob', time: T } });
    const kept = line('carol', 'still here');
    const w = mountWith([gone, own, kept]);
    expect(rowOf(w, gone.id).find('.body .deleted').text()).toBe('message deleted by opal: spam');
    expect(rowOf(w, own.id).find('.body .deleted').text()).toBe('message deleted');
    expect(rowOf(w, kept.id).find('.body .deleted').exists()).toBe(false);
    expect(rowOf(w, kept.id).find('.body').text()).toContain('still here');
  });

  it('blanks a line deleted while on screen, and takes its reactions down', async () => {
    const m = line('bob', 'oops');
    const w = mountWith([m]);
    useReactionsStore().byMessage.set(m.id, [{ nick: 'carol', value: '👍', self: false }]);
    await nextTick();
    expect(rowOf(w, m.id).find('.body').text()).toContain('oops');
    expect(rowOf(w, m.id).find('.reaction-row, .reactions').exists()).toBe(true);

    useRedactionsStore().applyFrame({
      networkId: 1,
      bufferId: 9,
      target: '#chan',
      messageId: m.id,
      by: 'bob',
      self: false,
      time: T,
    });
    await nextTick();
    const row = rowOf(w, m.id);
    expect(row.find('.body .deleted').text()).toBe('message deleted');
    expect(row.find('.body').text()).not.toContain('oops');
    expect(row.find('.reaction-row, .reactions').exists()).toBe(false);
  });

  it('quotes a deleted parent as deleted, not as unavailable', () => {
    const p = line('alice', null as never, { redaction: { by: 'alice', time: T } });
    const r = line('bob', 'alice: still?', {
      replyTo: {
        msgid: p.msgid,
        parent: {
          id: p.id,
          nick: 'alice',
          type: 'message',
          text: '',
          userhost: 'alice!~a@host',
          self: false,
          redacted: true,
        },
      },
    });
    const w = mountWith([p, r]);
    expect(rowOf(w, r.id).find('.reply-quote .reply-text').text()).toBe('<alice> message deleted');
  });
});
