// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';

interface Buf {
  id: number;
  networkId: number | null;
  kind: string;
  target: string;
}

const s = reactive({
  settingsLoaded: true,
  bufferNames: true as boolean,
  buffers: [] as Buf[],
  networks: [] as Array<{ id: number; name: string }>,
});

vi.mock('../stores/buffers.js', () => ({
  useBuffersStore: () => ({
    byId: (id: number) => s.buffers.find((b) => b.id === id) ?? null,
  }),
}));
vi.mock('../stores/networks.js', () => ({
  useNetworksStore: () => ({
    networkById: (id: number) => s.networks.find((n) => n.id === id) ?? null,
  }),
}));

vi.mock('../stores/settings.js', () => ({
  useSettingsStore: () => ({
    get loaded() {
      return s.settingsLoaded;
    },
    effective: (key: string) => (key === 'look.title.buffer_names' ? s.bufferNames : undefined),
  }),
}));

import { usePageTitle } from './usePageTitle.js';

const mounted: Array<{ unmount: () => void }> = [];
const blank = { render: () => null };

async function mkApp(path = '/') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'chat', component: blank },
      { path: '/system', name: 'system', component: blank },
      { path: '/buffer/:id', name: 'buffer', component: blank },
      { path: '/buffer/:id/members', name: 'buffer-members', component: blank },
      { path: '/settings/:category?', name: 'settings', component: blank },
    ],
  });
  await router.push(path);
  mounted.push(
    mount(
      defineComponent({
        setup() {
          usePageTitle();
          return () => h(RouterView);
        },
      }),
      { global: { plugins: [router] } },
    ),
  );
  await router.isReady();
  return router;
}

beforeEach(() => {
  document.title = 'stale';
  s.settingsLoaded = true;
  s.bufferNames = true;
  s.buffers = [{ id: 7, networkId: 1, kind: 'channel', target: '#lurker' }];
  s.networks = [{ id: 1, name: 'Libera' }];
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('usePageTitle', () => {
  it('titles the buffer the route names', async () => {
    await mkApp('/buffer/7');
    expect(document.title).toBe('#lurker / Libera - Lurker');
  });

  it('follows navigation between buffers, and back to the list', async () => {
    s.buffers.push({ id: 8, networkId: 1, kind: 'dm', target: 'amiantos' });
    const router = await mkApp('/buffer/7');

    await router.push('/buffer/8');
    expect(document.title).toBe('amiantos / Libera - Lurker');

    await router.push('/buffer/8/members');
    expect(document.title).toBe('amiantos / Libera - Lurker');

    await router.push('/');
    expect(document.title).toBe('Lurker');
  });

  it('picks the title up when a cold-start deep link resolves', async () => {
    s.buffers = [];
    await mkApp('/buffer/7');
    expect(document.title).toBe('Lurker');

    s.buffers.push({ id: 7, networkId: 1, kind: 'channel', target: '#lurker' });
    await nextTick();
    expect(document.title).toBe('#lurker / Libera - Lurker');
  });

  it('retitles in place when the network is renamed', async () => {
    await mkApp('/buffer/7');
    s.networks[0].name = 'Libera.Chat';
    await nextTick();
    expect(document.title).toBe('#lurker / Libera.Chat - Lurker');
  });

  it('names Settings, whatever buffer was open before it', async () => {
    const router = await mkApp('/buffer/7');
    await router.push('/settings/appearance');
    expect(document.title).toBe('Settings - Lurker');
  });

  it('titles every chat page Lurker with look.title.buffer_names off', async () => {
    s.buffers.push({ id: 9, networkId: 1, kind: 'server', target: ':server:1' });
    s.bufferNames = false;
    const router = await mkApp('/buffer/7');
    expect(document.title).toBe('Lurker');

    await router.push('/buffer/9');
    expect(document.title).toBe('Lurker');

    await router.push('/settings');
    expect(document.title).toBe('Settings - Lurker');

    await router.push('/buffer/7');
    s.bufferNames = true;
    await nextTick();
    expect(document.title).toBe('#lurker / Libera - Lurker');
  });

  it('holds the name back until the settings have loaded', async () => {
    s.settingsLoaded = false;
    await mkApp('/buffer/7');
    expect(document.title).toBe('Lurker');

    s.settingsLoaded = true;
    await nextTick();
    expect(document.title).toBe('#lurker / Libera - Lurker');
  });

  it('treats a hand-typed non-numeric id as no buffer', async () => {
    await mkApp('/buffer/foo');
    expect(document.title).toBe('Lurker');
  });
});
