// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The push log is read to find out why a notification did not arrive, so what
// it says before its data lands matters: "No client is connected" is a finding,
// and it used to be shown while the list was still on its way, or had failed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

const h = vi.hoisted(() => ({ api: vi.fn<(url: string) => Promise<unknown>>() }));
vi.mock('../api.js', () => ({ api: h.api }));

import PushLogModal from './PushLogModal.vue';

const mountModal = () => mount(PushLogModal, { global: { stubs: { Teleport: true } } });

describe('PushLogModal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.api.mockReset();
  });

  it('says nothing about clients until the list has arrived', async () => {
    let answer!: (v: unknown) => void;
    h.api.mockImplementation((url) =>
      url === '/api/push/clients'
        ? new Promise((resolve) => (answer = resolve))
        : Promise.resolve({ log: [] }),
    );
    const w = mountModal();
    await flushPromises();
    expect(w.text()).not.toContain('No client is connected');

    answer({ clients: [] });
    await flushPromises();
    expect(w.text()).toContain('No client is connected');
  });

  it('says the list could not be loaded, not that nobody is connected', async () => {
    h.api.mockImplementation((url) =>
      url === '/api/push/clients'
        ? Promise.reject(new Error('nope'))
        : Promise.resolve({ log: [] }),
    );
    const w = mountModal();
    await flushPromises();
    expect(w.text()).toContain('Could not load the client list');
    expect(w.text()).not.toContain('No client is connected');
  });
});
