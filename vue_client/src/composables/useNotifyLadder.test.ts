// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<(payload: unknown) => boolean>(() => true),
}));

import { useNotifyLadder } from './useNotifyLadder.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { SquareCheckIcon, SquareIcon } from '@lucide/vue';
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
