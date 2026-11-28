// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The property this file pins: EVERY store holding per-buffer state is swept
// by one bufferClosed() call, and rekeyed by one bufferRenamed() call. The
// old buffer-closed handler cleaned four stores of ~ten; a participant that
// forgets its hooks (or a new store that never joins the registry) should
// fail here, loudly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
}));

import { bufferClosed, bufferRenamed, applyBufferRenamed } from './bufferLifecycle.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useNavHistoryStore } from '../stores/navHistory.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useDraftStore } from '../stores/drafts.js';
import { useInputHistoryStore } from '../stores/inputHistory.js';
import { usePinsStore } from '../stores/pins.js';
import { useFavoritesStore } from '../stores/favorites.js';
import { useNicklistCollapseStore } from '../stores/nicklistCollapse.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';

const NET = 7;
const TARGET = '#lifecycle';
const KEY = `${NET}::${TARGET}`;

function seedEverything() {
  useBuffersStore().ensure(NET, TARGET, 42);
  useNetworksStore().activeKey = KEY;
  useNavHistoryStore().stack = [KEY, `${NET}::#other`];
  useNavHistoryStore().index = 0;
  useRecentBuffersStore().keys = [KEY, `${NET}::#other`];
  useDraftStore().drafts[KEY] = 'half-typed';
  useInputHistoryStore().seed(NET, TARGET, ['first line']);
  usePinsStore().byNetwork[NET] = [TARGET, '#other'];
  useFavoritesStore().entries = [
    { networkId: NET, target: TARGET, bufferId: 42 },
    { networkId: NET, target: '#other', bufferId: 43 },
  ];
  useNicklistCollapseStore().byNetwork[NET] = { [TARGET]: true };
  useChannelNotifyStore().byNetwork[NET] = { [TARGET]: { notifyAlways: true } };
}

// One assertion per participating store, so a regression names its store.
function presence() {
  return {
    buffer: !!useBuffersStore().buffers[KEY],
    activeKey: useNetworksStore().activeKey === KEY,
    navHistory: useNavHistoryStore().stack.includes(KEY),
    recent: useRecentBuffersStore().keys.includes(KEY),
    draft: KEY in useDraftStore().drafts,
    inputHistory: useInputHistoryStore().forBuffer(NET, TARGET).length > 0,
    pin: usePinsStore().byNetwork[NET]?.includes(TARGET) ?? false,
    favorite: useFavoritesStore().isFavorite(NET, TARGET),
    nicklist: TARGET in (useNicklistCollapseStore().byNetwork[NET] ?? {}),
    notify: TARGET in (useChannelNotifyStore().byNetwork[NET] ?? {}),
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('bufferClosed', () => {
  it('sweeps every participating store in one call', () => {
    seedEverything();
    expect(Object.values(presence()).every(Boolean)).toBe(true);

    bufferClosed(NET, TARGET);

    expect(presence()).toEqual({
      buffer: false,
      activeKey: false,
      navHistory: false,
      recent: false,
      draft: false,
      inputHistory: false,
      pin: false,
      favorite: false,
      nicklist: false,
      // The notify preference is kept on purpose: the server keeps it across a
      // leave and rejoin (#1421).
      notify: true,
    });
    // Rejoin: the buffer comes back and the ladder still reads All messages.
    useBuffersStore().ensure(NET, TARGET, 42);
    expect(useChannelNotifyStore().notifyAlways(NET, TARGET)).toBe(true);
    // Neighbors survive the sweep.
    expect(useNavHistoryStore().stack).toEqual([`${NET}::#other`]);
    expect(usePinsStore().byNetwork[NET]).toEqual(['#other']);
    expect(useFavoritesStore().entries.map((e) => e.target)).toEqual(['#other']);
  });

  it('resolves a divergently-cased close target onto the open buffer', () => {
    seedEverything();
    bufferClosed(NET, '#LIFECYCLE');
    expect(useBuffersStore().buffers[KEY]).toBeUndefined();
  });
});

describe('bufferRenamed', () => {
  it('moves every participating store onto the new name, keeping the id', () => {
    seedEverything();
    const RENAMED = '#reborn';
    const NEW_KEY = `${NET}::${RENAMED}`;

    bufferRenamed(NET, TARGET, RENAMED);

    const buffers = useBuffersStore();
    expect(buffers.buffers[KEY]).toBeUndefined();
    expect(buffers.buffers[NEW_KEY]?.target).toBe(RENAMED);
    // The identity survives the rename — that's the entire point of the id.
    expect(buffers.buffers[NEW_KEY]?.id).toBe(42);
    expect(useNetworksStore().activeKey).toBe(NEW_KEY);
    expect(useNavHistoryStore().stack[0]).toBe(NEW_KEY);
    expect(useRecentBuffersStore().keys[0]).toBe(NEW_KEY);
    expect(useDraftStore().drafts[NEW_KEY]).toBe('half-typed');
    expect(useInputHistoryStore().forBuffer(NET, RENAMED)).toEqual(['first line']);
    expect(usePinsStore().byNetwork[NET]).toEqual([RENAMED, '#other']);
    expect(useFavoritesStore().entries.map((e) => e.target)).toEqual([RENAMED, '#other']);
    expect(useNicklistCollapseStore().byNetwork[NET]?.[RENAMED]).toBe(true);
    expect(useChannelNotifyStore().byNetwork[NET]?.[RENAMED]).toEqual({ notifyAlways: true });
  });

  it('the id index follows the rename (frames by id land on the new key)', () => {
    seedEverything();
    bufferRenamed(NET, TARGET, '#reborn');
    // A later frame carrying bufferId 42 must resolve to the renamed buffer
    // even under the old name — the id fast path in ensureBuffer.
    const buf = useBuffersStore().ensure(NET, TARGET, 42);
    expect(buf.target).toBe('#reborn');
  });
});

describe('divergent casing reaches every store, not just buffers', () => {
  it('sweeps exact-string-keyed stores using the canonical casing', () => {
    // The buffers store resolves closes case-insensitively, but drafts/pins/
    // trails key EXACT strings built from the canonical casing — a raw-cased
    // sweep would clear the buffer and leak everything else.
    seedEverything();
    bufferClosed(NET, '#LIFECYCLE');
    expect(KEY in useDraftStore().drafts).toBe(false);
    expect(usePinsStore().byNetwork[NET]).toEqual(['#other']);
    expect(useRecentBuffersStore().keys).toEqual([`${NET}::#other`]);
  });
});

describe('rename collisions: destination wins everywhere', () => {
  it('drops the source entry instead of clobbering or duplicating', () => {
    seedEverything();
    const DEST = '#other';
    // Give the destination its own state so a clobber is detectable.
    useDraftStore().drafts[`${NET}::${DEST}`] = 'dest draft';
    useNicklistCollapseStore().byNetwork[NET]![DEST] = false;
    useChannelNotifyStore().byNetwork[NET]![DEST] = { notifyAlways: false };
    useInputHistoryStore().seed(NET, DEST, ['dest line']);
    useRecentBuffersStore().keys = [KEY, `${NET}::${DEST}`];

    bufferRenamed(NET, TARGET, DEST);

    expect(useDraftStore().drafts[`${NET}::${DEST}`]).toBe('dest draft');
    expect(useNicklistCollapseStore().byNetwork[NET]![DEST]).toBe(false);
    expect(useChannelNotifyStore().byNetwork[NET]![DEST]).toEqual({ notifyAlways: false });
    expect(useInputHistoryStore().forBuffer(NET, DEST)).toEqual(['dest line']);
    // Pins/favorites/MRU keep ONE entry for the destination, in its own slot.
    expect(usePinsStore().byNetwork[NET]).toEqual([DEST]);
    expect(useFavoritesStore().entries.map((e) => e.target)).toEqual([DEST]);
    expect(useRecentBuffersStore().keys).toEqual([`${NET}::${DEST}`]);
    // Nothing remains under the old name anywhere.
    expect(KEY in useDraftStore().drafts).toBe(false);
    expect(useBuffersStore().buffers[KEY]).toBeUndefined();
  });
});

describe('applyBufferRenamed — the full frame contract', () => {
  it('plain rename: moves everything, learns the id, keeps the slice', () => {
    seedEverything();
    const buf = useBuffersStore().buffers[KEY]!;
    buf.messages.push({ id: 1, networkId: NET, target: TARGET, type: 'message' });

    applyBufferRenamed({ networkId: NET, from: TARGET, to: '#fresh', bufferId: 42 });

    const moved = useBuffersStore().buffers[`${NET}::#fresh`]!;
    expect(moved.id).toBe(42);
    expect(moved.messages).toHaveLength(1); // no merge — history is untouched
    expect(useNetworksStore().activeKey).toBe(`${NET}::#fresh`);
  });

  it('merge: drops the absorbed buffer everywhere FIRST, then renames with no collision', () => {
    seedEverything();
    // The absorbed side: a stale buffer already holding the new name, with
    // state scattered across stores.
    const ABSORBED = '#stale';
    useBuffersStore().ensure(NET, ABSORBED, 99);
    useDraftStore().drafts[`${NET}::${ABSORBED}`] = 'stale draft';
    usePinsStore().byNetwork[NET] = [TARGET, ABSORBED];
    useChannelNotifyStore().byNetwork[NET]![ABSORBED] = { notifyAlways: false };
    const live = useBuffersStore().buffers[KEY]!;
    live.messages.push({ id: 5, networkId: NET, target: TARGET, type: 'message' });

    applyBufferRenamed({
      networkId: NET,
      from: TARGET,
      to: ABSORBED,
      bufferId: 42,
      merged: true,
    });

    const survivor = useBuffersStore().buffers[`${NET}::${ABSORBED}`]!;
    // The LIVE buffer survived under the new name — id 42, not the stale 99.
    expect(survivor.id).toBe(42);
    // Merged history interleaves server-side: the slice is wiped and flagged
    // for a fresh hydrate instead of guessed at.
    expect(survivor.messages).toHaveLength(0);
    expect(survivor.unseeded).toBe(true);
    expect(survivor.hasMoreOlder).toBe(true);
    // The stale buffer's satellite state is gone, not inherited; the live
    // buffer's own state moved in (destination-wins never fired — the
    // absorbed side was swept before the rename landed).
    expect(useDraftStore().drafts[`${NET}::${ABSORBED}`]).toBe('half-typed');
    expect(usePinsStore().byNetwork[NET]).toEqual([ABSORBED]);
    // A close keeps the notify flag (#1421); an absorbed buffer's still goes,
    // or it would win the collision and the live buffer's flag would be lost.
    expect(useChannelNotifyStore().byNetwork[NET]![ABSORBED]).toEqual({ notifyAlways: true });
  });

  it('refold orientation: the absorbed row is identified by id, never by `to`', () => {
    // The frame's OTHER producer (#707 casemapping refold) absorbs the FROM
    // row — the survivor already sits at `to` under its own name, no actual
    // rename. Reading orientation here ("drop `to`") swept the survivor — the
    // open channel the user was reading — out of every store.
    useBuffersStore().ensure(NET, '#foo{bar}', 42); // survivor
    useBuffersStore().ensure(NET, '#foo[bar]', 99); // absorbed bracket-twin
    useDraftStore().drafts[`${NET}::#foo[bar]`] = 'stale';

    applyBufferRenamed({
      networkId: NET,
      from: '#foo[bar]',
      to: '#foo{bar}',
      bufferId: 42,
      merged: true,
      mergedFromBufferId: 99,
    });

    const survivor = useBuffersStore().buffers[`${NET}::#foo{bar}`]!;
    expect(survivor.id).toBe(42);
    expect(survivor.unseeded).toBe(true); // history interleaved → refetch
    expect(useBuffersStore().buffers[`${NET}::#foo[bar]`]).toBeUndefined();
    expect(useDraftStore().drafts[`${NET}::#foo[bar]`]).toBeUndefined();
    // The absorbed side was DROPPED, not renamed onto the survivor — its
    // stale draft must not wear the survivor's key (the drop-`to`-then-rekey
    // failure mode converges on ids but leaks exactly this).
    expect(useDraftStore().drafts[`${NET}::#foo{bar}`]).toBeUndefined();
  });

  it('refold merge with the new fold known: the survivor keeps its own state (#1425)', () => {
    // The `casemapping` frame lands BEFORE the merge it causes, so by now
    // `from` folds onto the survivor. Rekeying the survivor onto its own key
    // ran every store's destination-wins branch against it.
    // The twins are from before the network said how it folds; once it has,
    // the store would not hold two.
    useBuffersStore().ensure(NET, '#keep{it}', 4242); // survivor
    useBuffersStore().ensure(NET, '#keep[it]', 9999); // absorbed bracket-twin
    useNetworksStore().applyCasemapping({ networkId: NET, casemapping: 'rfc1459' });
    const key = `${NET}::#keep{it}`;
    useDraftStore().drafts[key] = 'mine';
    usePinsStore().byNetwork[NET] = ['#keep{it}'];
    useRecentBuffersStore().keys = [key];
    useNetworksStore().activeKey = key;

    applyBufferRenamed({
      networkId: NET,
      from: '#keep[it]',
      to: '#keep{it}',
      bufferId: 4242,
      merged: true,
      mergedFromBufferId: 9999,
    });

    expect(useBuffersStore().buffers[key]?.id).toBe(4242);
    expect(useBuffersStore().buffers[`${NET}::#keep[it]`]).toBeUndefined();
    expect(useDraftStore().drafts[key]).toBe('mine');
    expect(usePinsStore().byNetwork[NET]).toEqual(['#keep{it}']);
    expect(useRecentBuffersStore().keys).toEqual([key]);
    expect(useNetworksStore().activeKey).toBe(key);
  });

  it('a merge frame can never leave the survivor rowless — worst case it re-materializes', () => {
    // The pathological corner: both twins held with NO learned ids, so neither
    // the id lookup nor the survivor-proof can orient the sweep. Whatever the
    // fallback decides, the frame proves a live buffer named `to` exists
    // server-side — the handler must end with a row there, flagged for a
    // fresh hydrate, never with the buffer vanished from the sidebar.
    // Names and ids unused by any other test: the id→key index is
    // module-level and outlives each test's pinia, so reused values would
    // quietly route this through the id-known path instead of the corner.
    useBuffersStore().ensure(NET, '#twin{a}');
    useBuffersStore().ensure(NET, '#twin[a]');

    applyBufferRenamed({
      networkId: NET,
      from: '#twin[a]',
      to: '#twin{a}',
      bufferId: 4200,
      merged: true,
      mergedFromBufferId: 9900,
    });

    const survivor = useBuffersStore().buffers[`${NET}::#twin{a}`];
    expect(survivor).toBeTruthy();
    expect(survivor?.id).toBe(4200);
    expect(survivor?.unseeded).toBe(true);
  });

  it('a refold merge with the absorbed id unknown still spares the proven survivor', () => {
    // Fallback path: no local row carries mergedFromBufferId, so the DM
    // orientation would say "drop `to`" — but the row at `to` records the
    // SURVIVING id, which is proof it must stay.
    useBuffersStore().ensure(NET, '#foo{bar}', 42);

    applyBufferRenamed({
      networkId: NET,
      from: '#foo[bar]',
      to: '#foo{bar}',
      bufferId: 42,
      merged: true,
      mergedFromBufferId: 99,
    });

    expect(useBuffersStore().buffers[`${NET}::#foo{bar}`]?.id).toBe(42);
  });
});
