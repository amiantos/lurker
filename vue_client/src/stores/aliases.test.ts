// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api } from '../api.js';
import { resetAliases, useAliasesStore } from './aliases.js';

vi.mock('../api.js', () => ({ api: vi.fn<(path: string) => Promise<unknown>>() }));

const list = (...names: string[]) => ({ aliases: names.map((name) => ({ name, body: '/quit' })) });

describe('the aliases store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(api).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('finds an alias by the verb as typed', async () => {
    vi.mocked(api).mockResolvedValue(list('wii'));
    const store = useAliasesStore();
    await store.fetchAll();
    expect(store.find('/WII')?.name).toBe('wii');
    expect(store.find('who')).toBeUndefined();
  });

  it('fetches again when the list changed while a fetch was out', async () => {
    let answerFirst!: (value: unknown) => void;
    vi.mocked(api)
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce(list('new'));
    const store = useAliasesStore();
    const first = store.fetchAll();
    // An aliases-changed frame lands before the first answer does.
    store.applyServerChanged();
    answerFirst(list('old'));
    await first;
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
    expect(store.aliases.map((a) => a.name)).toEqual(['new']);
  });

  it('drops an answer that arrives after sign-out', async () => {
    let answer!: (value: unknown) => void;
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const store = useAliasesStore();
    const out = store.fetchAll();
    resetAliases();
    answer(list('theirs'));
    await out;
    expect(store.aliases).toEqual([]);
    expect(store.loaded).toBe(false);
    // And the next account's load is its own request, not the old one's promise.
    vi.mocked(api).mockResolvedValueOnce(list('mine'));
    await store.fetchAll();
    expect(store.aliases.map((a) => a.name)).toEqual(['mine']);
  });

  it('reads the list back after a write', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ alias: { name: 'a', body: '/quit' }, created: true })
      // Another device wrote `b` in the meantime.
      .mockResolvedValueOnce(list('a', 'b'));
    const store = useAliasesStore();
    await store.set('a', '/quit');
    await vi.waitFor(() => expect(store.aliases.map((a) => a.name)).toEqual(['a', 'b']));
  });

  it('lets a command wait for a first load that is still out', async () => {
    let answer!: (value: unknown) => void;
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const store = useAliasesStore();
    store.load();
    let waited = false;
    const wait = store.settled().then(() => (waited = true));
    await Promise.resolve();
    expect(waited).toBe(false);
    answer(list('wii'));
    await wait;
    expect(store.find('wii')).toBeDefined();
  });

  it('retries a first load that failed, and stops once it has the list', async () => {
    vi.useFakeTimers();
    vi.mocked(api)
      .mockRejectedValueOnce(new Error('502'))
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValue(list('wii'));
    const store = useAliasesStore();
    store.load();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.loaded).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.loaded).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.mocked(api)).toHaveBeenCalledTimes(3);
  });
});
