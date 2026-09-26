// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The reply line above a reply (#993), through the real MessageList: what it
// quotes, when it quotes nothing, the `nick: ` it makes redundant, the
// highlight a reply to you carries, and what the Reply action starts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useHighlightRulesStore } from '../stores/highlightRules.js';
import { useRepliesStore } from '../stores/replies.js';
import type { ReplyParent } from '../../../shared/replies.js';
import * as jumpIntent from '../composables/useJumpIntent.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const KEY = '1::#chan';
let wrapper: VueWrapper | null = null;

const parent = (over: Partial<ReplyParent> = {}): ReplyParent => ({
  id: 1,
  nick: 'alice',
  type: 'message',
  text: 'what \x02time\x02 is it?',
  userhost: 'alice!~a@host',
  self: false,
  ...over,
});

let nextId = 1;
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
    time: new Date(Date.UTC(2026, 8, 25, 12, id)).toISOString(),
    self: nick === 'me',
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
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = KEY;
  wrapper = mount(MessageList, { attachTo: document.body });
  return wrapper;
}

const rowOf = (w: VueWrapper, id: number) => w.find(`[data-msg-id="${id}"]`);

describe('MessageList — replies', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    nextId = 1;
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('quotes the answered line above the reply, and drops the address it repeats', () => {
    const p = line('alice', 'what \x02time\x02 is it?', { msgid: 'm1' });
    const r = line('bob', 'alice: noon', {
      replyTo: { msgid: 'm1', parent: parent({ id: p.id }) },
    });
    const w = mountWith([p, r]);
    const row = rowOf(w, r.id);
    // Quoted as IRC writes it, formatting dropped, opened by the arm in the body
    // column (inside the excerpt), not the nick column.
    expect(row.find('.reply-quote').text()).toBe('<alice> what time is it?');
    expect(row.find('.reply-excerpt .reply-mark').text()).toBe('┌─');
    expect(row.find('.body').text()).toBe('noon');
    // A plain line has no reply line.
    expect(rowOf(w, p.id).find('.reply-ctx').exists()).toBe(false);
  });

  it('says the answered line is unavailable when it isn’t there', () => {
    const r = line('bob', 'lol same', { replyTo: { msgid: 'gone', parent: null } });
    const w = mountWith([r]);
    expect(rowOf(w, r.id).find('.reply-ctx').classes()).toContain('missing');
    expect(rowOf(w, r.id).find('.reply-quote').text()).toBe('original message unavailable');
  });

  it('won’t quote someone ignored since, even though the server sent the line', () => {
    useIgnoresStore().global = [
      {
        id: 1,
        createdAt: '',
        mask: 'alice!*@*',
        channels: null,
        pattern: null,
        patternKind: 'substr',
        levels: ['ALL'],
        isExcept: false,
        expiresAt: null,
      },
    ];
    const r = line('bob', 'alice: noon', { replyTo: { msgid: 'm1', parent: parent() } });
    const w = mountWith([r]);
    expect(rowOf(w, r.id).find('.reply-quote').text()).toBe('original message unavailable');
    expect(rowOf(w, r.id).text()).not.toContain('what time');
    // With no quote naming her, the address is the only sign of who it's to.
    expect(rowOf(w, r.id).find('.body').text()).toBe('alice: noon');
  });

  it('jumps to the answered line from the keyboard, and offers nothing when it’s gone', async () => {
    const jump = vi.spyOn(jumpIntent, 'emitJumpIntent');
    const p = line('alice', 'what time is it?', { msgid: 'm1' });
    const r = line('bob', 'noon', { replyTo: { msgid: 'm1', parent: parent({ id: p.id }) } });
    const gone = line('bob', 'lol', { replyTo: { msgid: 'x', parent: null } });
    const w = mountWith([p, r, gone]);
    const ctx = rowOf(w, r.id).find('.reply-ctx');
    expect(ctx.attributes('role')).toBe('button');
    expect(ctx.attributes('tabindex')).toBe('0');
    await ctx.trigger('keydown', { key: 'Enter' });
    await ctx.trigger('keydown', { key: ' ' });
    expect(jump).toHaveBeenCalledTimes(2);
    expect(jump).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'jump', networkId: 1, target: '#chan', messageId: p.id }),
    );
    const missing = rowOf(w, gone.id).find('.reply-ctx');
    expect(missing.attributes('role')).toBeUndefined();
    expect(missing.attributes('tabindex')).toBeUndefined();
    jump.mockRestore();
  });

  it('quotes a /me and a notice the way IRC writes them', () => {
    const a = line('bob', 'rip', {
      replyTo: { msgid: 'm1', parent: parent({ nick: 'carol', type: 'action', text: 'waves' }) },
    });
    const n = line('bob', 'thanks', {
      replyTo: { msgid: 'm2', parent: parent({ nick: 'ChanServ', type: 'notice', text: 'hi' }) },
    });
    const w = mountWith([a, n]);
    expect(rowOf(w, a.id).find('.reply-quote').text()).toBe('* carol waves');
    expect(rowOf(w, n.id).find('.reply-quote').text()).toBe('-ChanServ- hi');
  });

  // The tint follows the server's stamp, which is what the badge and the feed
  // count — not the parent, which can be gone by now.
  it('keeps a reply to you highlighted once the rules are evaluated live', () => {
    const rules = useHighlightRulesStore();
    rules.loaded = true;
    const toMe = line('bob', 'good question', {
      matched: true,
      replyToSelf: true,
      replyTo: { msgid: 'm1', parent: parent({ nick: 'me', self: true }) },
    });
    const parentGone = line('bob', 'still to you', {
      matched: true,
      replyToSelf: true,
      replyTo: { msgid: 'm3', parent: null },
    });
    const toAlice = line('bob', 'not you', { replyTo: { msgid: 'm2', parent: parent() } });
    const w = mountWith([toMe, parentGone, toAlice]);
    expect(rowOf(w, toMe.id).classes()).toContain('highlight');
    expect(rowOf(w, parentGone.id).classes()).toContain('highlight');
    expect(rowOf(w, toAlice.id).classes()).not.toContain('highlight');
  });

  it('starts a reply from the Reply action on a line with a msgid', async () => {
    const p = line('alice', 'what time is it?', { msgid: 'm1' });
    const w = mountWith([p]);
    const reply = rowOf(w, p.id)
      .findAll('.row-actions button')
      .find((b) => b.attributes('title')?.startsWith('Reply'));
    expect(reply).toBeTruthy();
    await reply!.trigger('click');
    expect(useRepliesStore().forKey(KEY)).toMatchObject({
      messageId: p.id,
      nick: 'alice',
      type: 'message',
      text: 'what time is it?',
    });
  });

  it('only addresses them when the line has no msgid to reply to', async () => {
    const p = line('alice', 'untagged network');
    const w = mountWith([p]);
    const reply = rowOf(w, p.id)
      .findAll('.row-actions button')
      .find((b) => b.attributes('title')?.startsWith('Reply'));
    await reply!.trigger('click');
    expect(useRepliesStore().forKey(KEY)).toBeNull();
  });
});
