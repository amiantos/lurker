// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { api } from '../api.js';
import { useSettingsStore } from './settings.js';

vi.mock('../api.js', () => ({ api: vi.fn<(path: string) => Promise<unknown>>() }));

const KEY = 'look.title.buffer_names';

describe('the settings store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(api).mockReset();
  });

  // #1464: a `settings` frame sent while this device was disconnected never
  // arrived; the snapshot on reconnect restates the stored overrides.
  describe('applySnapshot', () => {
    async function loaded(values: Record<string, unknown>) {
      vi.mocked(api).mockResolvedValue({ values, themes: [] });
      const store = useSettingsStore();
      await store.fetchAll();
      return store;
    }

    it('picks up a setting changed elsewhere while disconnected', async () => {
      const store = await loaded({});
      expect(store.effective(KEY)).toBe(true);
      store.applySnapshot({ [KEY]: false });
      expect(store.effective(KEY)).toBe(false);
    });

    it('drops an override that was reset elsewhere', async () => {
      const store = await loaded({ [KEY]: false });
      store.applySnapshot({});
      expect(KEY in store.values).toBe(false);
      expect(store.effective(KEY)).toBe(true);
    });

    // The bootstrap brings the saved themes with the values; values alone
    // would point the resolver at a theme that has not arrived.
    it('waits for the bootstrap before taking anything', () => {
      const store = useSettingsStore();
      store.applySnapshot({ [KEY]: false });
      expect(store.values).toEqual({});
      expect(store.loaded).toBe(false);
    });
  });
});
