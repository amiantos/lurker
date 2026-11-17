// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const api = vi.fn<(path: string, opts?: { method?: string; body?: unknown }) => Promise<any>>();
vi.mock('../../api.js', () => ({ api: (...a: [string]) => api(...a) }));

import GeneralPane from './GeneralPane.vue';
import { useConfigStore } from '../../stores/config.js';

async function mountPane(stored: string | null) {
  api.mockResolvedValueOnce({ jitsiUrl: stored });
  const wrapper = mount(GeneralPane);
  await flushPromises();
  return { wrapper, input: wrapper.find('input') };
}

beforeEach(() => {
  setActivePinia(createPinia());
  api.mockReset();
});

describe('Admin → General: Jitsi server', () => {
  it('shows the stored server', async () => {
    const { input } = await mountPane('https://old.example');
    expect(input.element.value).toBe('https://old.example');
  });

  it('saves a new server and shows it as stored', async () => {
    const { input } = await mountPane(null);
    api.mockResolvedValueOnce({ jitsiUrl: 'https://meet.example.org' });
    await input.setValue('https://meet.example.org/');
    await input.trigger('change');
    await flushPromises();
    expect(api).toHaveBeenLastCalledWith('/api/admin/general/jitsi', {
      method: 'PUT',
      body: { url: 'https://meet.example.org/' },
    });
    expect(input.element.value).toBe('https://meet.example.org');
  });

  // What was typed stays in the box beside the reason, so it can be fixed.
  it('keeps what was typed when it is not a URL, and asks nothing of the server', async () => {
    const { wrapper, input } = await mountPane('https://old.example');
    await input.setValue('meet.example.org');
    await input.trigger('change');
    await flushPromises();
    expect(api).toHaveBeenCalledTimes(1);
    expect(input.element.value).toBe('meet.example.org');
    expect(wrapper.text()).toContain('not a Jitsi address');
  });

  it('keeps what was typed when the server refuses it', async () => {
    const { wrapper, input } = await mountPane('https://old.example');
    api.mockRejectedValueOnce(new Error('nope'));
    await input.setValue('https://new.example');
    await input.trigger('change');
    await flushPromises();
    expect(input.element.value).toBe('https://new.example');
    expect(wrapper.text()).toContain('nope');
  });

  it('follows a change another admin made', async () => {
    const { input } = await mountPane('https://old.example');
    useConfigStore().jitsiUrl = 'https://other.example';
    await flushPromises();
    expect(input.element.value).toBe('https://other.example');
  });
});
