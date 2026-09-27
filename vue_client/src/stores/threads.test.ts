// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The thread view's data: what a `thread` answer fills, what a live reply
// joins, and what the channel's own copy of the first line learns about it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useThreadsStore } from './threads.js';
import type { ThreadMessage } from './threads.js';
import { useBuffersStore } from './buffers.js';
import { useNetworksStore } from './networks.js';
import { socketSend } from '../composables/useSocket.js';
import { threadViewBuffer } from '../lib/threadViewing.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const sent = () => vi.mocked(socketSend).mock.calls.map((c) => c[0] as Record<string, unknown>);

function msg(id: number, extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick: 'alice',
    text: `line ${id}`,
    ...extra,
  } as ThreadMessage;
}

describe('threads store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    useNetworksStore().networks = [{ id: 1, name: 'net' }] as never;
    useBuffersStore().ensure(1, '#chan', 9);
  });

  it('asks for the thread whole and keeps only the answer to the latest ask', () => {
    const threads = useThreadsStore();
    threads.open(9, 'r');
    expect(sent().at(-1)).toMatchObject({ type: 'thread', bufferId: 9, rootMsgid: 'r' });
    const first = sent().at(-1)!.token as number;
    threads.open(9, 'other');
    const second = sent().at(-1)!.token as number;

    // The first ask's answer lands late: not what's on screen.
    threads.applyThread({ bufferId: 9, rootMsgid: 'r', token: first, root: msg(1), replies: [] });
    expect(threads.view?.root).toBeNull();
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'other',
      token: second,
      root: msg(1, { msgid: 'other' }),
      replies: [msg(2)],
    });
    expect(threads.view).toMatchObject({ loading: false, rootMsgid: 'other' });
    expect(threads.view?.replies.map((r) => r.id)).toEqual([2]);
  });

  it('marks the channel as on screen only while its thread view is open', () => {
    const threads = useThreadsStore();
    threads.open(9, 'r');
    expect(threadViewBuffer()).toBe('1::#chan');
    threads.close();
    expect(threadViewBuffer()).toBeNull();
  });

  it('a live reply joins the thread on screen and counts on the first line, wherever it is', () => {
    const threads = useThreadsStore();
    const buffers = useBuffersStore();
    buffers.byId(9)!.messages = [msg(1, { msgid: 'r', threadReplies: 1 })] as never;
    threads.open(9, 'r');
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'r',
      token: sent().at(-1)!.token as number,
      root: msg(1, { msgid: 'r', threadReplies: 1 }),
      replies: [msg(2, { replyTo: { msgid: 'r', root: 'r', parent: null } })],
    });

    threads.applyLive(msg(3, { replyTo: { msgid: 'r', root: 'r', parent: null } }));
    expect(threads.view?.replies.map((r) => r.id)).toEqual([2, 3]);
    expect(threads.view?.root?.threadReplies).toBe(2);
    expect((buffers.byId(9)!.messages[0] as ThreadMessage).threadReplies).toBe(2);

    // A reply in some other thread touches neither.
    threads.applyLive(msg(4, { replyTo: { msgid: 'x', root: 'x', parent: null } }));
    expect(threads.view?.replies).toHaveLength(2);
  });

  it('a reply that lands between the ask and the answer isn’t lost', () => {
    const threads = useThreadsStore();
    threads.open(9, 'r');
    threads.applyLive(msg(5, { replyTo: { msgid: 'r', root: 'r', parent: null } }));
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'r',
      token: sent().at(-1)!.token as number,
      root: msg(1, { msgid: 'r' }),
      replies: [msg(2, { replyTo: { msgid: 'r', root: 'r', parent: null } })],
    });
    expect(threads.view?.replies.map((r) => r.id)).toEqual([2, 5]);
  });

  it('sends a line from the view as a reply to the first line — or its oldest held reply', () => {
    const threads = useThreadsStore();
    threads.open(9, 'r');
    const token = sent().at(-1)!.token as number;
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'r',
      token,
      root: msg(1, { msgid: 'r' }),
      replies: [],
    });
    expect(threads.defaultReply('1::#chan')).toMatchObject({ messageId: 1, nick: 'alice' });
    expect(threads.defaultReply('1::#other')).toBeNull();

    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'r',
      token,
      root: null,
      replies: [msg(2, { msgid: 'm2', nick: 'bob' })],
    });
    expect(threads.defaultReply('1::#chan')).toMatchObject({ messageId: 2, nick: 'bob' });
  });

  it('never sends a plain line tagged as a reply to an encrypted first line', () => {
    const threads = useThreadsStore();
    threads.open(9, 'r');
    const token = sent().at(-1)!.token as number;
    threads.applyThread({
      bufferId: 9,
      rootMsgid: 'r',
      token,
      root: msg(1, { msgid: 'r', e2e: true }),
      replies: [],
    });
    expect(threads.defaultReply('1::#chan')).toBeNull();
  });

  it('counts a reply on its first line even when that line is itself an older reply', () => {
    const threads = useThreadsStore();
    const buffers = useBuffersStore();
    // Stored before threads were tracked: a reply with no root of its own, so
    // the server roots the new reply at it.
    buffers.byId(9)!.messages = [
      msg(1, { msgid: 'old', replyTo: { msgid: 'gone', parent: null } }),
    ] as never;
    threads.applyLive(msg(2, { replyTo: { msgid: 'old', root: 'old', parent: null } }));
    expect((buffers.byId(9)!.messages[0] as ThreadMessage).threadReplies).toBe(1);
  });

  it('moves the read pointer only for a followed thread with something unread', () => {
    const threads = useThreadsStore();
    threads.open(9, 'r');
    const token = sent().at(-1)!.token as number;
    threads.applyThread({ bufferId: 9, rootMsgid: 'r', token, root: null, replies: [msg(2)] });
    threads.markViewRead();
    expect(sent().some((m) => m.type === 'thread-read')).toBe(false);

    const followed = {
      networkId: 1,
      bufferId: 9,
      target: '#chan',
      rootMsgid: 'r',
      root: null,
      highlighted: false,
      lastReplyId: 2,
      lastReplyTime: '',
    };
    threads.applyFollowed([{ ...followed, unread: 0 }]);
    threads.markViewRead();
    expect(sent().some((m) => m.type === 'thread-read')).toBe(false);
    threads.applyFollowed([{ ...followed, unread: 1 }]);
    threads.markViewRead();
    expect(sent().at(-1)).toEqual({
      type: 'thread-read',
      bufferId: 9,
      rootMsgid: 'r',
      messageId: 2,
    });
  });

  it('× takes a thread off the list at once and tells the server', () => {
    const threads = useThreadsStore();
    threads.applyFollowed([
      {
        networkId: 1,
        bufferId: 9,
        target: '#chan',
        rootMsgid: 'r',
        root: null,
        unread: 0,
        highlighted: false,
        lastReplyId: 2,
        lastReplyTime: '',
      },
    ]);
    threads.unfollow(9, 'r');
    expect(threads.forBuffer(9)).toEqual([]);
    expect(sent().at(-1)).toEqual({ type: 'thread-close', bufferId: 9, rootMsgid: 'r' });
  });
});
