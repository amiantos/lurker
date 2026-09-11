// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The engine line in Settings → About (#920): what GET /api/about's answer
// turns into, including the answers that should leave no line at all.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string) => Promise<unknown>>(),
}));
vi.mock('../../api.js', () => ({ api: h.api }));
// Injected by vite's `define` in a build; the test project has no such step.
vi.stubGlobal('APP_VERSION', '2.3.1');

import AboutPane from './AboutPane.vue';

async function mountWith(answer: () => Promise<unknown>) {
  h.api.mockImplementation(answer);
  const wrapper = mount(AboutPane);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  h.api.mockReset();
});

describe('AboutPane engine line', () => {
  it("shows the engine's own version beside the app's", async () => {
    const w = await mountWith(async () => ({ engine: { connected: true, version: '2.3.0' } }));
    expect(h.api).toHaveBeenCalledWith('/api/about');
    expect(w.text()).toContain('version 2.3.1');
    expect(w.find('.engine-version').text()).toBe('engine 2.3.0');
  });

  // The server keeps the last version a dropped engine reported; naming it
  // here would read as an engine that is running fine.
  it('says the engine is not connected rather than naming the version it last had', async () => {
    const w = await mountWith(async () => ({ engine: { connected: false, version: '2.3.0' } }));
    expect(w.find('.engine-version').text()).toBe('engine not connected');
  });

  it('shows no engine line when the instance runs without one', async () => {
    const w = await mountWith(async () => ({ engine: null }));
    expect(w.find('.engine-version').exists()).toBe(false);
  });

  it('shows no engine line when the request fails', async () => {
    const w = await mountWith(() => Promise.reject(new Error('offline')));
    expect(w.find('.engine-version').exists()).toBe(false);
    expect(w.text()).toContain('version 2.3.1');
  });
});
