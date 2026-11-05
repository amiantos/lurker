// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRedactionsStore } from './redactions.js';
import { useReactionsStore } from './reactions.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const t = '2026-11-05T00:00:00.000Z';

describe('redactions store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('answers from the row itself when nothing live has been heard', () => {
    const store = useRedactionsStore();
    expect(store.get({ id: 1 })).toBeUndefined();
    expect(store.get({ id: 1, redaction: { by: 'bob', time: t } })).toEqual({ by: 'bob', time: t });
    expect(store.get(null)).toBeUndefined();
  });

  it('notes a row’s deletion as it arrives, and forgets one a fresh row no longer carries', () => {
    const store = useRedactionsStore();
    store.noteFromEvents([{ id: 7, redaction: { by: 'opal', time: t } }, { id: 8 }], 1);
    expect(store.get({ id: 7 })).toEqual({ by: 'opal', time: t });
    expect(store.get({ id: 8 })).toBeUndefined();
    store.noteFromEvents([{ id: 7 }], 1);
    expect(store.get({ id: 7 })).toBeUndefined();
  });

  it('marks a line live from the frame, reactions and all', () => {
    const store = useRedactionsStore();
    const reactions = useReactionsStore();
    reactions.byMessage.set(5, [{ nick: 'carol', value: '👍', self: false }]);
    store.applyFrame({
      networkId: 1,
      bufferId: 9,
      target: '#chan',
      messageId: 5,
      by: 'bob',
      reason: 'typo',
      self: false,
      time: t,
    });
    expect(store.get({ id: 5 })).toEqual({ by: 'bob', reason: 'typo', time: t });
    expect(reactions.byMessage.has(5)).toBe(false);
  });
});
