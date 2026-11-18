// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Admin → DCC (#1080, #1125). Rows are text until "edit", which turns that
// row's cells into controls under their own headers, with one save. A field
// that saved silently on blur left admins pressing Enter to make sure, so
// nothing saves until asked, and "saved" says it landed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(),
}));
vi.mock('../../api.js', () => ({ api: h.api }));

import DccPane from './DccPane.vue';

const GB = 1024 ** 3;

function info(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    directory: '/srv/dcc',
    maxFileBytes: 0,
    allowPrivateHosts: false,
    freeDiskFloorBytes: GB,
    users: [
      {
        id: 3,
        username: 'alice',
        chat: true,
        receive: false,
        limitBytes: 50 * GB,
        usedBytes: 0,
        ...over,
      },
    ],
  };
}

async function mountPane(over: Record<string, unknown> = {}, enabled = true): Promise<VueWrapper> {
  h.api.mockResolvedValueOnce({ ...info(over), enabled });
  // The edit modal teleports to body; stubbed, it renders in place.
  const wrapper = mount(DccPane, { global: { stubs: { Teleport: true } } });
  await flushPromises();
  return wrapper;
}

const button = (w: VueWrapper, label: string) =>
  w.findAll('button').find((b) => b.text() === label)!;
const row = (w: VueWrapper) => w.find('table.users tbody tr').text();
const boxes = (w: VueWrapper) => w.findAll('.modal input[type="checkbox"]');
const limitField = (w: VueWrapper) => w.find('.modal input[type="number"]');
const editorOpen = (w: VueWrapper) => w.find('.modal').exists();
const limitValue = (w: VueWrapper) => (limitField(w).element as HTMLInputElement).value;

beforeEach(() => {
  setActivePinia(createPinia());
  h.api.mockReset();
});

describe('Admin → DCC', () => {
  it('shows each user as text, with no inputs until edit', async () => {
    const w = await mountPane();
    expect(row(w)).toContain('alice');
    expect(row(w)).toContain('50.00 GB');
    expect(w.find('table.users input').exists()).toBe(false);
  });

  it('edits in a modal, and saves chat, receive and the limit together', async () => {
    const w = await mountPane();
    await button(w, 'edit').trigger('click');
    expect(w.find('.modal').text()).toContain('dcc for alice');
    expect(w.find('table.users input').exists()).toBe(false); // the table stays text
    await boxes(w)[1].setValue(true); // receive
    await limitField(w).setValue('25');
    h.api.mockResolvedValueOnce({ chat: true, receive: true, limitBytes: 25 * GB });
    await w.find('.modal form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenLastCalledWith('/api/admin/dcc/users/3', {
      method: 'PUT',
      body: { chat: true, receive: true, limitBytes: 25 * GB },
    });
    expect(editorOpen(w)).toBe(false);
    expect(row(w)).toContain('25.00 GB');
  });

  it('saves on the form submit an Enter in the limit field makes', async () => {
    const w = await mountPane();
    await button(w, 'edit').trigger('click');
    await limitField(w).setValue('30');
    h.api.mockResolvedValueOnce({ chat: true, receive: false, limitBytes: 30 * GB });
    await w.find('.modal form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenLastCalledWith('/api/admin/dcc/users/3', {
      method: 'PUT',
      body: { chat: true, receive: false, limitBytes: 30 * GB },
    });
    expect(editorOpen(w)).toBe(false);
  });

  it('clears the limit when the field is emptied', async () => {
    const w = await mountPane();
    await button(w, 'edit').trigger('click');
    await limitField(w).setValue('');
    h.api.mockResolvedValueOnce({ chat: true, receive: false, limitBytes: null });
    await w.find('.modal form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenLastCalledWith('/api/admin/dcc/users/3', {
      method: 'PUT',
      body: { chat: true, receive: false, limitBytes: null },
    });
    expect(row(w)).toContain('none');
  });

  it('changes nothing on cancel', async () => {
    const w = await mountPane();
    await button(w, 'edit').trigger('click');
    await limitField(w).setValue('99');
    await button(w, 'Cancel').trigger('click');
    expect(editorOpen(w)).toBe(false);
    expect(h.api).toHaveBeenCalledTimes(1); // just the load
    expect(row(w)).toContain('50.00 GB');
  });

  it('closes on Escape, changing nothing', async () => {
    const w = await mountPane();
    await button(w, 'edit').trigger('click');
    await limitField(w).setValue('99');
    await w.find('.modal').trigger('keydown', { key: 'Escape' });
    expect(editorOpen(w)).toBe(false);
    expect(row(w)).toContain('50.00 GB');
    expect(h.api).toHaveBeenCalledTimes(1);
  });

  it('keeps the modal open with what was typed when the save fails', async () => {
    const w = await mountPane();
    await button(w, 'edit').trigger('click');
    await limitField(w).setValue('25');
    h.api.mockRejectedValueOnce(new Error('network down'));
    await w.find('.modal form').trigger('submit');
    await flushPromises();
    expect(w.text()).toContain('network down');
    expect(limitValue(w)).toBe('25');
    expect(editorOpen(w)).toBe(true);
  });

  it('refuses a limit that is not a positive number, without a request', async () => {
    const w = await mountPane();
    await button(w, 'edit').trigger('click');
    await limitField(w).setValue('-3');
    await w.find('.modal form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(w.text()).toContain('above 0');
  });

  // A small limit read back as 0 looked like none, or like an invalid one.
  it('shows a small saved limit with the precision it has', async () => {
    const w = await mountPane({ limitBytes: Math.round(0.001 * GB) });
    await button(w, 'edit').trigger('click');
    expect(limitValue(w)).toBe('0.001');
  });

  // With DCC off for the instance a grant can be cleared before it comes back
  // on, but not given.
  it('lets a part be taken away, not given, while DCC is off', async () => {
    const w = await mountPane({}, false);
    await button(w, 'edit').trigger('click');
    const [chat, receive] = boxes(w);
    expect((chat.element as HTMLInputElement).disabled).toBe(false);
    expect((receive.element as HTMLInputElement).disabled).toBe(true);
  });
});
