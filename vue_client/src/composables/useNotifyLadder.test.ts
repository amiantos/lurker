// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<(payload: unknown) => boolean>(() => true),
}));

import { CUSTOM_NOTE, useNotifyLadder } from './useNotifyLadder.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { CircleDotIcon, SquareCheckIcon, SquareIcon } from '@lucide/vue';
import { useIgnoresStore, type IgnoreEntry } from '../stores/ignores.js';

describe('useNotifyLadder channel rungs', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(useIgnoresStore(), 'addRule').mockImplementation(() => undefined as never);
    vi.spyOn(useIgnoresStore(), 'removeRule').mockImplementation(() => undefined as never);
  });

  // A rung is a target: it reconciles against the state at the tap, not as it
  // was when the menu opened (#1136).
  it('clears notify-always set elsewhere while the menu was open', () => {
    const notify = useChannelNotifyStore();
    const set = vi.spyOn(notify, 'setNotifyAlways');
    const items = useNotifyLadder().channelItems(1, '#chan');
    // Another device turns All messages on while this menu sits open.
    notify.applyChange(1, '#chan', { notifyAlways: true });
    items.find((i) => i.label === 'Highlights only')?.onClick?.();
    expect(set).toHaveBeenCalledWith(1, '#chan', false);
  });

  it('leaves notify-always alone when it already matches at the tap', () => {
    const notify = useChannelNotifyStore();
    const set = vi.spyOn(notify, 'setNotifyAlways');
    notify.applyChange(1, '#chan', { notifyAlways: true });
    const items = useNotifyLadder().channelItems(1, '#chan');
    // Turned off elsewhere; Highlights only now has nothing to change there.
    notify.applyChange(1, '#chan', { notifyAlways: false });
    items.find((i) => i.label === 'Highlights only')?.onClick?.();
    expect(set).not.toHaveBeenCalled();
  });
});

// "Suppress Highlights" (#1414): a box beside the ladder, stored as a
// NOHIGHLIGHT rule of its own so the rung's rule is never rewritten.
describe('useNotifyLadder Suppress Highlights', () => {
  let added: Array<{ channels: string[] | null; levels: string[] }>;
  let removed: number[];

  const rule = (levels: string[], channels: string[] | null, id = 9): IgnoreEntry => ({
    id,
    mask: null,
    channels,
    pattern: null,
    patternKind: 'substr',
    levels,
    isExcept: false,
    expiresAt: null,
    createdAt: '',
  });
  const seed = (rules: IgnoreEntry[], global: IgnoreEntry[] = []) =>
    useIgnoresStore().applySnapshot([{ networkId: 1, ignoredMasks: rules }], global);
  const tap = (
    items: ReturnType<ReturnType<typeof useNotifyLadder>['channelItems']>,
    label: string,
  ) => items.find((i) => i.label === label)!.onClick!();
  const box = (items: ReturnType<ReturnType<typeof useNotifyLadder>['channelItems']>) =>
    items.find((i) => i.label === 'Suppress Highlights');

  beforeEach(() => {
    setActivePinia(createPinia());
    added = [];
    removed = [];
    const ignores = useIgnoresStore();
    vi.spyOn(ignores, 'addRule').mockImplementation(((_net: number, r: IgnoreEntry) => {
      added.push({ channels: r.channels, levels: r.levels });
    }) as never);
    vi.spyOn(ignores, 'removeRule').mockImplementation(((_net: number, r: { id: number }) => {
      removed.push(r.id);
    }) as never);
  });

  it('adds a rule of its own and touches nothing else', () => {
    seed([rule(['NOUNREAD', 'NONOTIFY'], ['#chan'])]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(box(items)!.icon).toBe(SquareIcon);
    tap(items, 'Suppress Highlights');
    expect(added).toEqual([{ channels: ['#chan'], levels: ['NOHIGHLIGHT'] }]);
    expect(removed).toEqual([]);
  });

  it('shows checked, beside whatever level is set', () => {
    seed([rule(['NOUNREAD', 'NONOTIFY'], ['#chan']), rule(['NOHIGHLIGHT'], ['#chan'], 10)]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(box(items)!.icon).toBe(SquareCheckIcon);
    expect(items.find((i) => i.label === 'Muted')!.icon).not.toBe(
      items.find((i) => i.label === 'Nothing')!.icon,
    );
  });

  it('clearing it removes only its own rule', () => {
    seed([rule(['NOUNREAD', 'NONOTIFY'], ['#chan']), rule(['NOHIGHLIGHT'], ['#chan'], 10)]);
    tap(useNotifyLadder().channelItems(1, '#chan'), 'Suppress Highlights');
    expect(removed).toEqual([10]);
    expect(added).toEqual([]);
  });

  it('is left alone by a change of level', () => {
    seed([rule(['NOHIGHLIGHT'], ['#chan'], 10)]);
    tap(useNotifyLadder().channelItems(1, '#chan'), 'Muted');
    expect(removed).toEqual([]);
    expect(added).toHaveLength(1);
    expect(added[0].levels).not.toContain('NOHIGHLIGHT');
  });

  it('does not read a hand-typed NOUNREAD rule as its own, or disturb it', () => {
    seed([rule(['NOUNREAD'], ['#chan'])]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(box(items)!.icon).toBe(SquareIcon);
    tap(items, 'Suppress Highlights');
    expect(removed).toEqual([]);
  });

  it('acts on the state at the tap, not as the menu opened', () => {
    seed([]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    // Ticked on another device while this menu sat open: nothing to add.
    seed([rule(['NOHIGHLIGHT'], ['#chan'], 10)]);
    tap(items, 'Suppress Highlights');
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("works network-wide, apart from a channel's own", () => {
    seed([rule(['NOHIGHLIGHT'], ['#chan'], 10)]);
    const items = useNotifyLadder().networkItems(1);
    expect(box(items)!.icon).toBe(SquareIcon);
    tap(items, 'Suppress Highlights');
    expect(added).toEqual([{ channels: null, levels: ['NOHIGHLIGHT'] }]);
  });

  it('is not offered on a DM', () => {
    seed([]);
    expect(box(useNotifyLadder().dmItems(1, 'alice'))).toBeUndefined();
  });
});

// The menu shows what is in force from every silencing rule at the scope, and
// only edits when those are exactly the rules it writes itself.
describe('useNotifyLadder with custom rules', () => {
  type Items = ReturnType<ReturnType<typeof useNotifyLadder>['channelItems']>;

  const rule = (over: Partial<IgnoreEntry>): IgnoreEntry => ({
    id: 9,
    mask: null,
    channels: ['#chan'],
    pattern: null,
    patternKind: 'substr',
    levels: [],
    isExcept: false,
    expiresAt: null,
    createdAt: '',
    ...over,
  });
  const seed = (rules: IgnoreEntry[], global: IgnoreEntry[] = []) =>
    useIgnoresStore().applySnapshot([{ networkId: 1, ignoredMasks: rules }], global);
  const picked = (items: Items) => items.find((i) => i.icon === CircleDotIcon)?.label;
  const box = (items: Items) => items.find((i) => i.label === 'Suppress Highlights')!;
  const rungs = (items: Items) => items.filter((i) => i.label && i.label !== 'Suppress Highlights');
  const rungsLocked = (items: Items) => rungs(items).every((i) => i.disabled);
  const rungsOpen = (items: Items) => rungs(items).every((i) => !i.disabled);
  const noted = (items: Items) => items.some((i) => i.note === CUSTOM_NOTE);
  const locked = (items: Items) =>
    rungsLocked(items) && noted(items) && (box(items)?.disabled ?? true);
  const open = (items: Items) => items.every((i) => !i.disabled) && !noted(items);

  beforeEach(() => setActivePinia(createPinia()));

  it('shows a combined rule as what it does, and does not edit it', () => {
    seed([rule({ levels: ['NOHIGHLIGHT', 'NOUNREAD', 'NONOTIFY'] })]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(picked(items)).toBe('Muted');
    expect(box(items).icon).toBe(SquareCheckIcon);
    expect(locked(items)).toBe(true);
  });

  it('leaves the rules the menu writes itself editable', () => {
    seed([rule({ levels: ['NOUNREAD', 'NONOTIFY'] }), rule({ id: 10, levels: ['NOHIGHLIGHT'] })]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(picked(items)).toBe('Muted');
    expect(box(items).icon).toBe(SquareCheckIcon);
    expect(open(items)).toBe(true);
  });

  it('does not edit a timed mute, which a level change would make permanent', () => {
    seed([rule({ levels: ['NOUNREAD', 'NONOTIFY'], expiresAt: '2999-01-01T00:00:00.000Z' })]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(picked(items)).toBe('Muted');
    expect(rungsLocked(items)).toBe(true);
    expect(noted(items)).toBe(true);
    // The box is a rule of its own and stays usable.
    expect(box(items).disabled).toBeFalsy();
  });

  it('locks only the box for a timed Suppress Highlights', () => {
    seed([rule({ levels: ['NOHIGHLIGHT'], expiresAt: '2999-01-01T00:00:00.000Z' })]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(box(items).icon).toBe(SquareCheckIcon);
    expect(box(items).disabled).toBe(true);
    expect(rungsOpen(items)).toBe(true);
    expect(noted(items)).toBe(true);
  });

  it('does not edit a hand-typed NOUNREAD with no NONOTIFY', () => {
    seed([rule({ levels: ['NOUNREAD'] })]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(rungsLocked(items)).toBe(true);
  });

  it('does not reconcile against a lapsed rule the server has yet to sweep', () => {
    const ignores = useIgnoresStore();
    const add = vi.spyOn(ignores, 'addRule').mockImplementation(() => undefined as never);
    const remove = vi.spyOn(ignores, 'removeRule').mockImplementation(() => undefined as never);
    seed([rule({ levels: ['NOUNREAD', 'NONOTIFY'], expiresAt: '2001-01-01T00:00:00.000Z' })]);
    useNotifyLadder()
      .channelItems(1, '#chan')
      .find((i) => i.label === 'Muted')!.onClick!();
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it("shows the menu's own Nothing over All messages, as the veto would", () => {
    seed([rule({ levels: ['NONOTIFY'] })]);
    useChannelNotifyStore().applyChange(1, '#chan', { notifyAlways: true });
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(picked(items)).toBe('Nothing');
    expect(open(items)).toBe(true);
  });

  it('ignores a timed mute that has lapsed', () => {
    seed([rule({ levels: ['NOUNREAD', 'NONOTIFY'], expiresAt: '2001-01-01T00:00:00.000Z' })]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(picked(items)).toBe('Highlights only');
    expect(open(items)).toBe(true);
  });

  it('does not edit when two rules of a kind cover the scope', () => {
    seed([rule({ levels: ['NONOTIFY'] })], [rule({ id: 10, levels: ['NOUNREAD', 'NONOTIFY'] })]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(picked(items)).toBe('Muted');
    expect(locked(items)).toBe(true);
  });

  it('shows a custom silencing rule over All messages, as the veto would', () => {
    seed([rule({ levels: ['NOHIGHLIGHT', 'NONOTIFY'] })]);
    useChannelNotifyStore().applyChange(1, '#chan', { notifyAlways: true });
    expect(picked(useNotifyLadder().channelItems(1, '#chan'))).toBe('Nothing');
  });

  it('is not moved by rules about a sender, a phrase, or event types', () => {
    seed([
      rule({ id: 1, mask: 'bob', levels: ['NONOTIFY'] }),
      rule({ id: 2, pattern: 'spam', levels: ['NOHIGHLIGHT'] }),
      rule({ id: 3, levels: ['JOINS', 'NONOTIFY'] }),
      rule({ id: 4, isExcept: true, levels: ['NONOTIFY'] }),
      rule({ id: 5, channels: ['#other'], levels: ['NOUNREAD', 'NONOTIFY'] }),
    ]);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(picked(items)).toBe('Highlights only');
    expect(box(items).icon).toBe(SquareIcon);
    expect(open(items)).toBe(true);
  });

  it('locks the network menu and the DM menu the same way', () => {
    seed([
      rule({ channels: null, levels: ['NOHIGHLIGHT', 'NONOTIFY'] }),
      rule({ id: 10, channels: ['alice'], levels: ['NOHIGHLIGHT', 'NOUNREAD', 'NONOTIFY'] }),
    ]);
    const net = useNotifyLadder().networkItems(1);
    expect(picked(net)).toBe('Nothing');
    expect(box(net).icon).toBe(SquareCheckIcon);
    expect(locked(net)).toBe(true);

    const dm = useNotifyLadder().dmItems(1, 'alice');
    expect(picked(dm)).toBe('Muted');
    expect(locked(dm)).toBe(true);
  });
});
