// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The DCC button (#1085), in the desktop rail. It opens the DCC window, shows for an account with DCC, and warns
// while an offer waits for an answer.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../api.js', () => ({
  api: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ transfers: [] })),
}));
const features = vi.hoisted(() => ({ dcc: true }));
vi.mock('../stores/config.js', () => ({
  useConfigStore: () => ({ fetch: async () => 'standalone', features }),
}));

import DccButton from './DccButton.vue';
import { useDccStore } from '../stores/dcc.js';

type Transfer = ReturnType<typeof useDccStore>['transfers'][number];
const row = (id: number, state: string) => ({ id, state }) as unknown as Transfer;

beforeEach(() => {
  setActivePinia(createPinia());
  features.dcc = true;
});

describe('DccButton', () => {
  it('is hidden for an account without DCC', () => {
    useDccStore().account = { chat: false, receive: false, send: false };
    expect(mount(DccButton).find('button').exists()).toBe(false);
  });

  it('is hidden where DCC is off, grant or not', () => {
    features.dcc = false;
    useDccStore().account = { chat: false, receive: true, send: false };
    expect(mount(DccButton).find('button').exists()).toBe(false);
  });

  it('shows for a grant, and takes the class its view gives it', () => {
    useDccStore().account = { chat: false, receive: true, send: false };
    const b = mount(DccButton, { attrs: { class: 'icon' } }).find('button');
    expect(b.classes()).toEqual(expect.arrayContaining(['icon', 'dcc-btn']));
    expect(b.classes()).not.toContain('pending');
    expect(b.attributes('title')).toBe('DCC');
  });

  it('shows for transfers left from before a grant went', () => {
    useDccStore().transfers = [row(1, 'completed')];
    expect(mount(DccButton).find('button').exists()).toBe(true);
  });

  it('turns warn-colored and says how many offers wait', async () => {
    const w = mount(DccButton);
    useDccStore().transfers = [row(1, 'pending_approval'), row(2, 'pending_approval')];
    await w.vm.$nextTick();
    expect(w.find('button').classes()).toContain('pending');
    expect(w.find('button').attributes('title')).toBe('DCC — 2 offers waiting');
  });

  it('opens the DCC window', async () => {
    const dcc = useDccStore();
    dcc.account = { chat: true, receive: false, send: false };
    const w = mount(DccButton);
    await w.find('button').trigger('click');
    expect(dcc.panelOpen).toBe(true);
  });
});
