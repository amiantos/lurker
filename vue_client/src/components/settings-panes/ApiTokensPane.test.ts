// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Settings → Bouncer sends people here for a token to log an IRC client in
// with, and the bouncer refuses a read-only one — so that link asks for the
// write box to start ticked.

import { describe, it, expect, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(),
  query: {} as Record<string, string>,
}));
vi.mock('../../api.js', () => ({ api: h.api }));
vi.mock('vue-router', () => ({ useRoute: () => ({ query: h.query }) }));

import ApiTokensPane from './ApiTokensPane.vue';

async function mountWith(query: Record<string, string>) {
  setActivePinia(createPinia());
  h.query = query;
  h.api.mockImplementation(async () => ({ items: [] }));
  // The create modal teleports to body; stubbed, it renders in place.
  const wrapper = mount(ApiTokensPane, { global: { stubs: { Teleport: true } } });
  await flushPromises();
  return wrapper;
}

describe('ApiTokensPane', () => {
  it('starts read-only, as most tokens should be', async () => {
    const w = await mountWith({});
    expect(w.find('.modal').exists()).toBe(false);
    await w.find('.add-row button').trigger('click');
    expect((w.find('.check input').element as HTMLInputElement).checked).toBe(false);
  });

  it('opens write-enabled when asked for the scope the bouncer needs', async () => {
    const w = await mountWith({ scope: 'read-write' });
    expect((w.find('.modal .check input').element as HTMLInputElement).checked).toBe(true);
  });

  it('shows the new token in the same modal, once, and forgets it on Done', async () => {
    const w = await mountWith({});
    await w.find('.add-row button').trigger('click');
    await w.find('.modal input[type="text"]').setValue('autonotes');
    h.api.mockImplementation(async (_url, opts?: { method?: string }) =>
      opts?.method === 'POST' ? { name: 'autonotes', token: 'lrk_secret' } : { items: [] },
    );
    await w.find('.modal form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenCalledWith('/api/api-tokens', {
      method: 'POST',
      body: { name: 'autonotes', scope: 'read' },
    });
    expect(w.find('.modal .token').text()).toBe('lrk_secret');
    expect(w.find('.modal input[type="text"]').exists()).toBe(false);

    const done = w.findAll('.modal-footer button').find((b) => b.text() === 'Done')!;
    await done.trigger('click');
    expect(w.find('.modal').exists()).toBe(false);
    expect(w.text()).not.toContain('lrk_secret');
  });
});
