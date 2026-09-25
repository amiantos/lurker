// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// loadInitial's skipIfSameFilter contract: the modal's debounced-typing path
// passes true so no-op input changes (trailing space, half-typed filter token)
// don't blank + refetch, while mount-time loads omit it and ALWAYS refetch —
// highlights are a live feed, the same filter can have new rows.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const api = vi.fn<(url: string) => Promise<any>>();
vi.mock('../api.js', () => ({
  api: (url: string) => api(url),
}));

const { useHighlightsStore } = await import('./highlights.js');

beforeEach(() => {
  setActivePinia(createPinia());
  api.mockReset();
  api.mockResolvedValue({ items: [{ id: 1 }], next: null });
});

describe('loadInitial skipIfSameFilter', () => {
  it('skips a debounced reload when the filter is unchanged', async () => {
    const store = useHighlightsStore();
    store.setQuery('from:amiantos');
    await store.loadInitial(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(store.items).toEqual([{ id: 1 }]);

    store.setQuery('from:amiantos '); // trailing space — same effective filter
    await store.loadInitial(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(store.items).toEqual([{ id: 1 }]);
  });

  it('reloads when the filter actually changes', async () => {
    const store = useHighlightsStore();
    store.setQuery('from:amiantos');
    await store.loadInitial(true);
    store.setQuery('from:amiantos deploy');
    await store.loadInitial(true);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('a mount-time load always refetches the live feed', async () => {
    const store = useHighlightsStore();
    store.setQuery('from:amiantos');
    await store.loadInitial(true);
    await store.loadInitial(); // modal reopened — same filter, fresh rows
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('retries an identical filter after an error', async () => {
    const store = useHighlightsStore();
    api.mockRejectedValueOnce(new Error('boom'));
    store.setQuery('from:amiantos');
    await store.loadInitial(true);
    expect(store.error).toBe('boom');

    await store.loadInitial(true);
    expect(api).toHaveBeenCalledTimes(2);
    expect(store.error).toBe('');
    expect(store.items).toEqual([{ id: 1 }]);
  });
});

describe('paging the activity feed', () => {
  // The server pages two sources at once and hands back a cursor for each; the
  // store sends both back untouched, and stops when the server says null.
  it('sends back the cursor pair, and stops at null', async () => {
    const store = useHighlightsStore();
    api.mockResolvedValueOnce({
      items: [{ id: 1 }],
      next: { beforeMessage: 40, beforeReaction: 7 },
    });
    await store.loadInitial();
    expect(api.mock.calls[0][0]).toMatch(/^\/api\/activity\?/);
    expect(store.hasMore).toBe(true);

    api.mockResolvedValueOnce({ items: [{ id: 2 }], next: null });
    await store.loadMore();
    const url = new URL(api.mock.calls[1][0], 'http://x');
    expect(url.searchParams.get('beforeMessage')).toBe('40');
    expect(url.searchParams.get('beforeReaction')).toBe('7');
    expect(store.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(store.hasMore).toBe(false);
  });
});
