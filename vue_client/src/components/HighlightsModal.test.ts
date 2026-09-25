// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The activity modal's ignore filter. A reaction row is judged as what it is —
// the reactor sending the reaction — not as the user's own line it sits on.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const api = vi.fn<(url: string) => Promise<unknown>>();
vi.mock('../api.js', () => ({ api: (url: string) => api(url) }));
vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import HighlightsModal from './HighlightsModal.vue';
import { useIgnoresStore, type IgnoreEntry } from '../stores/ignores.js';

const NET = 1;

function rule(over: Partial<IgnoreEntry>): IgnoreEntry {
  return {
    id: 1,
    mask: null,
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels: ['ALL'],
    isExcept: false,
    expiresAt: null,
    createdAt: '',
    ...over,
  } as IgnoreEntry;
}

const reaction = (nick: string, userhost: string, value: string, reactionId: number) => ({
  kind: 'reaction',
  id: 10,
  reactionId,
  networkId: NET,
  target: '#c',
  nick,
  userhost,
  value,
  text: 'my spoiler line',
  time: '2026-09-25T12:00:00.000Z',
});

async function openWith(rules: IgnoreEntry[]) {
  useIgnoresStore().applySnapshot([{ networkId: NET, ignoredMasks: rules }], []);
  api.mockResolvedValue({
    items: [
      reaction('carol', 'carol!~c@good.host', '👍', 1),
      reaction('mallory', 'mallory!~m@evil.host', '🎉', 2),
    ],
    next: null,
  });
  const wrapper = mount(HighlightsModal, { attachTo: document.body });
  await flushPromises();
  return wrapper;
}

const shown = (wrapper: Awaited<ReturnType<typeof openWith>>) =>
  wrapper.findAll('.match-list .reaction').map((r) => r.text());

describe('activity modal ignore filter', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    api.mockReset();
  });

  it('matches a pattern ignore against the reaction, not the line it’s on', async () => {
    // The user's own line says "spoiler"; neither reaction does.
    const wrapper = await openWith([rule({ pattern: 'spoiler' })]);
    expect(shown(wrapper)).toEqual(['👍', '🎉']);
    wrapper.unmount();
  });

  it('applies a host-mask ignore to the reactor', async () => {
    const wrapper = await openWith([rule({ mask: '*!*@evil.host' })]);
    expect(shown(wrapper)).toEqual(['👍']);
    wrapper.unmount();
  });
});
