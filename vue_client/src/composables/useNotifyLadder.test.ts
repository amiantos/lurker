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

// "Suppress Highlights" (#1414): a box beside the ladder that adds NOHIGHLIGHT
// to the same rule the rungs write.
describe('useNotifyLadder Suppress Highlights', () => {
  let added: Array<{ channels: string[] | null; levels: string[] }>;
  let removed: number[];

  const rule = (levels: string[], channels: string[] | null): IgnoreEntry => ({
    id: 9,
    mask: null,
    channels,
    pattern: null,
    patternKind: 'substr',
    levels,
    isExcept: false,
    expiresAt: null,
    createdAt: '',
  });
  const seed = (levels: string[] | null, channels: string[] | null = ['#chan']) =>
    useIgnoresStore().applySnapshot(
      [{ networkId: 1, ignoredMasks: levels ? [rule(levels, channels)] : [] }],
      [],
    );
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

  it('is a rule of its own on a rung that has none', () => {
    seed(null);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(box(items)!.icon).toBe(SquareIcon);
    tap(items, 'Suppress Highlights');
    expect(added).toEqual([{ channels: ['#chan'], levels: ['NOHIGHLIGHT'] }]);
    expect(removed).toEqual([]);
  });

  it('joins the rule of a muted channel, and shows checked from then on', () => {
    seed(['NOUNREAD', 'NONOTIFY']);
    tap(useNotifyLadder().channelItems(1, '#chan'), 'Suppress Highlights');
    expect(removed).toEqual([9]);
    expect(added).toHaveLength(1);
    expect(new Set(added[0].levels)).toEqual(new Set(['NOUNREAD', 'NONOTIFY', 'NOHIGHLIGHT']));

    seed(added[0].levels);
    const items = useNotifyLadder().channelItems(1, '#chan');
    expect(box(items)!.icon).toBe(SquareCheckIcon);
    // Still read as Muted with the extra level on it.
    expect(items.find((i) => i.label === 'Muted')!.icon).not.toBe(
      items.find((i) => i.label === 'Nothing')!.icon,
    );
  });

  it('clearing it on a plain rung removes the rule', () => {
    seed(['NOHIGHLIGHT']);
    tap(useNotifyLadder().channelItems(1, '#chan'), 'Suppress Highlights');
    expect(removed).toEqual([9]);
    expect(added).toEqual([]);
  });

  it('survives a change of rung', () => {
    seed(['NOHIGHLIGHT']);
    tap(useNotifyLadder().channelItems(1, '#chan'), 'Nothing');
    expect(new Set(added[0].levels)).toEqual(new Set(['NONOTIFY', 'NOHIGHLIGHT']));

    added = [];
    seed(['NOUNREAD', 'NONOTIFY', 'NOHIGHLIGHT']);
    tap(useNotifyLadder().channelItems(1, '#chan'), 'Highlights only');
    expect(added).toEqual([{ channels: ['#chan'], levels: ['NOHIGHLIGHT'] }]);
  });

  it('keeps All messages when ticked there', () => {
    seed(null);
    const notify = useChannelNotifyStore();
    notify.applyChange(1, '#chan', { notifyAlways: true });
    const set = vi.spyOn(notify, 'setNotifyAlways');
    tap(useNotifyLadder().channelItems(1, '#chan'), 'Suppress Highlights');
    expect(added).toEqual([{ channels: ['#chan'], levels: ['NOHIGHLIGHT'] }]);
    expect(set).not.toHaveBeenCalled();
  });

  it('works network-wide', () => {
    seed(['NONOTIFY'], null);
    const items = useNotifyLadder().networkItems(1);
    tap(items, 'Suppress Highlights');
    expect(added[0].channels).toBeNull();
    expect(new Set(added[0].levels)).toEqual(new Set(['NONOTIFY', 'NOHIGHLIGHT']));
  });

  it('is not offered on a DM', () => {
    seed(null);
    expect(box(useNotifyLadder().dmItems(1, 'alice'))).toBeUndefined();
  });
});
