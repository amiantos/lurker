// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// The store only reaches the socket for mutations — mock it so we exercise the
// store's own logic (global∪network union, snapshot/update routing, allEntries).
const h = vi.hoisted(() => ({ socketSend: vi.fn<(payload: unknown) => void>() }));
vi.mock('../composables/useSocket.js', () => ({ socketSend: h.socketSend }));

import { useIgnoresStore, type IgnoreEntry } from './ignores.js';
import type { IgnoreInput } from '../utils/ignoreMatch.js';

function entry(over: Partial<IgnoreEntry> = {}): IgnoreEntry {
  return {
    id: 1,
    mask: 'x',
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels: ['ALL'],
    isExcept: false,
    expiresAt: null,
    createdAt: '',
    ...over,
  };
}

const ctx = (nick: string): IgnoreInput => ({
  nick,
  userhost: null,
  target: '#x',
  text: '',
  type: 'message',
  isDm: false,
});

beforeEach(() => {
  setActivePinia(createPinia());
  h.socketSend.mockClear();
});

describe('ignores store — global vs network scope (#350)', () => {
  it('a global rule hides on every network; a network rule only on its own', () => {
    const s = useIgnoresStore();
    s.applySnapshot(
      [
        { networkId: 1, ignoredMasks: [] },
        { networkId: 2, ignoredMasks: [] },
      ],
      [entry({ id: 1, mask: 'globe' })],
    );
    expect(s.isHidden(1, ctx('globe'))).toBe(true);
    expect(s.isHidden(2, ctx('globe'))).toBe(true);

    s.applyUpdate(1, [entry({ id: 2, mask: 'localonly' })]);
    expect(s.isHidden(1, ctx('localonly'))).toBe(true);
    expect(s.isHidden(2, ctx('localonly'))).toBe(false);
    // The global rule still applies on network 1 alongside its own rule.
    expect(s.isHidden(1, ctx('globe'))).toBe(true);
  });

  it('applyUpdate(null) replaces the global bucket and re-unions on read', () => {
    const s = useIgnoresStore();
    s.applySnapshot([{ networkId: 1, ignoredMasks: [] }], [entry({ id: 1, mask: 'a' })]);
    expect(s.isHidden(1, ctx('a'))).toBe(true);
    s.applyUpdate(null, []);
    expect(s.isHidden(1, ctx('a'))).toBe(false);
  });

  it('allEntries lists globals with networkId null plus per-network entries', () => {
    const s = useIgnoresStore();
    s.applySnapshot(
      [{ networkId: 5, ignoredMasks: [entry({ id: 2, mask: 'net' })] }],
      [entry({ id: 1, mask: 'glob' })],
    );
    const all = s.allEntries;
    expect(all).toContainEqual(expect.objectContaining({ id: 1, mask: 'glob', networkId: null }));
    expect(all).toContainEqual(expect.objectContaining({ id: 2, mask: 'net', networkId: 5 }));
  });

  it('addRule routes scope onto the wire (null = global, number = network)', () => {
    const s = useIgnoresStore();
    s.addRule(null, entry({ mask: 'g' }));
    expect(h.socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'add-ignore', networkId: null }),
    );
    s.addRule(7, entry({ mask: 'n' }));
    expect(h.socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'add-ignore', networkId: 7 }),
    );
  });
});

describe('ignores store — matcher getters union global + network', () => {
  it('evaluate hides senders matched by either a global or a network rule', () => {
    const s = useIgnoresStore();
    s.applySnapshot(
      [{ networkId: 1, ignoredMasks: [entry({ id: 2, mask: 'neto', levels: ['PUBLIC'] })] }],
      [entry({ id: 1, mask: 'globo' })],
    );
    expect(s.evaluate(1, ctx('globo')).hide).toBe(true);
    expect(s.evaluate(1, ctx('neto')).hide).toBe(true);
    expect(s.evaluate(1, ctx('nobody')).hide).toBe(false);
  });

  it('isMessageHidden honors a global rule for message-shaped result rows', () => {
    const s = useIgnoresStore();
    s.applySnapshot([{ networkId: 1, ignoredMasks: [] }], [entry({ id: 1, mask: 'spam' })]);
    expect(s.isMessageHidden(1, { nick: 'spam', target: '#x', body: 'hi' })).toBe(true);
    expect(s.isMessageHidden(1, { nick: 'ok', target: '#x', body: 'hi' })).toBe(false);
    expect(s.isMessageHidden(1, { nick: null, target: '#x' })).toBe(false);
  });

  it('isIgnored and isMemberHidden see a whole-identity global rule', () => {
    const s = useIgnoresStore();
    s.applySnapshot([{ networkId: 1, ignoredMasks: [] }], [entry({ id: 1, mask: 'troll' })]);
    expect(s.isIgnored(1, 'troll', '')).toBe(true);
    expect(s.isMemberHidden(1, 'troll', null, '#x')).toBe(true);
    expect(s.isMemberHidden(1, 'friend', null, '#x')).toBe(false);
  });

  it('removeRule / removeMask / addMask route to the socket with the right scope', () => {
    const s = useIgnoresStore();
    s.removeRule(null, { id: 9 });
    expect(h.socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'remove-ignore', networkId: null, id: 9 }),
    );
    s.removeMask(3, 'bob');
    expect(h.socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'remove-ignore', networkId: 3, mask: 'bob' }),
    );
    s.addMask(null, 'eve');
    expect(h.socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'add-ignore', networkId: null, mask: 'eve' }),
    );
  });
});
