// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { socketSend } from '../composables/useSocket.js';
import { useReactionsStore } from './reactions.js';
import type { ReactionFrame } from './reactions.js';

const NET = 1;

function frame(fields: Partial<ReactionFrame>): ReactionFrame {
  return {
    networkId: NET,
    bufferId: 5,
    target: '#c',
    messageId: 10,
    nick: 'bob',
    value: '👍',
    self: false,
    remove: false,
    toSelf: false,
    time: '2026-09-25T00:00:00.000Z',
    ...fields,
  };
}

// What stands on each line is a cache of what this tab has SEEN: rows say what's
// on them, live frames change it. These are the rules that keep it honest.
describe('reactions store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
  });

  it('groups a line’s reactions by value, first-reacted first, and marks ours', () => {
    const store = useReactionsStore();
    store.noteFromEvents(
      [
        {
          id: 10,
          reactions: [
            { nick: 'bob', value: '👍', self: false },
            { nick: 'carol', value: 'lol', self: false },
            { nick: 'me', value: '👍', self: true },
          ],
        },
      ],
      NET,
    );
    expect(store.groupsFor(10)).toEqual([
      { value: '👍', nicks: ['bob', 'me'], mine: true },
      { value: 'lol', nicks: ['carol'], mine: false },
    ]);
    expect(store.groupsFor(11)).toEqual([]);
  });

  // A row that arrives without reactions is telling us none stand on it now —
  // how a removal made while this tab was away reaches it.
  it('clears a line when its row comes back bare, and leaves lines the page doesn’t carry', () => {
    const store = useReactionsStore();
    const reactions = [{ nick: 'bob', value: '👍', self: false }];
    store.noteFromEvents(
      [
        { id: 10, reactions },
        { id: 20, reactions },
      ],
      NET,
    );
    store.noteFromEvents([{ id: 10 }], NET);
    expect(store.groupsFor(10)).toEqual([]);
    expect(store.groupsFor(20)).toHaveLength(1);
  });

  // System-buffer ids are their own sequence and overlap message ids.
  it('ignores system-buffer rows', () => {
    const store = useReactionsStore();
    store.noteFromEvents([{ id: 10, reactions: [{ nick: 'b', value: 'x', self: false }] }], NET);
    store.noteFromEvents([{ id: 10 }], null);
    expect(store.groupsFor(10)).toHaveLength(1);
  });

  it('applies live frames, matching an unreact’s nick case-insensitively', () => {
    const store = useReactionsStore();
    store.applyFrame(frame({ nick: 'bob' }));
    store.applyFrame(frame({ nick: 'carol' }));
    // A repeat doesn't double up.
    store.applyFrame(frame({ nick: 'bob' }));
    expect(store.groupsFor(10)).toEqual([{ value: '👍', nicks: ['bob', 'carol'], mine: false }]);
    store.applyFrame(frame({ nick: 'BOB', remove: true }));
    store.applyFrame(frame({ nick: 'carol', remove: true }));
    expect(store.groupsFor(10)).toEqual([]);
  });

  it('takes a reaction back from the feed when it’s removed', () => {
    const store = useReactionsStore();
    store.items = [
      {
        id: 10,
        reactionId: 1,
        networkId: NET,
        networkName: 'n',
        target: '#c',
        nick: 'bob',
        value: '👍',
        time: '',
        text: 'mine',
        messageTime: '',
      },
    ];
    store.applyFrame(frame({ toSelf: true, remove: true, nick: 'Bob' }));
    expect(store.items).toEqual([]);
  });

  // Toggle: react when it isn't ours yet, take it back when it is. Nothing is
  // shown until the server's echo comes back as a frame.
  it('toggles by sending, never by rendering', () => {
    const store = useReactionsStore();
    store.toggle(10, '👍');
    expect(socketSend).toHaveBeenLastCalledWith({
      type: 'react',
      messageId: 10,
      value: '👍',
      remove: false,
    });
    expect(store.groupsFor(10)).toEqual([]);
    store.applyFrame(frame({ nick: 'me', self: true }));
    store.toggle(10, '👍');
    expect(socketSend).toHaveBeenLastCalledWith({
      type: 'react',
      messageId: 10,
      value: '👍',
      remove: true,
    });
  });
});
