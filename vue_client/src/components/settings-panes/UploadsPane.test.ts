// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The destination list is a radio group: the dot is the selection, and picking a
// row is the request. It used to be a "use this one" button per row plus an "in
// use" badge, with the add and edit forms opening inline beneath the list; both
// are a modal now. Mounted and clicked, because a radio that shows one row and
// selects another is invisible to a test of the handler alone.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<unknown>>(),
}));
vi.mock('../../api.js', () => ({ api: h.api }));

import UploadsPane from './UploadsPane.vue';

const ZIPLINE = {
  driver: 'zipline',
  label: 'Zipline',
  creatable: true,
  configSchema: [
    { key: 'url', label: 'URL', type: 'string', required: true, description: 'Where it lives.' },
  ],
};
const CATBOX = { driver: 'catbox', label: 'catbox', creatable: true, configSchema: [] };

function listing(selectedId: number | null) {
  return {
    uploaders: [
      { id: 1, driver: 'x0', label: 'x0.at', scope: 'instance', enabled: true, editable: false },
      {
        id: 2,
        driver: 'zipline',
        label: 'my zipline',
        scope: 'user',
        enabled: true,
        editable: true,
        config: { url: 'https://z.example' },
        secretsSet: {},
      },
    ],
    drivers: [ZIPLINE, CATBOX],
    selectedId,
    allowUserDefined: true,
  };
}

let selectionFails = false;

async function mountPane(selectedId: number | null = 1) {
  setActivePinia(createPinia());
  h.api.mockImplementation(async (url, opts) => {
    if (url === '/api/uploaders' && !opts?.method) return listing(selectedId);
    if (url === '/api/uploaders/selection' && selectionFails) throw new Error('nope');
    return {};
  });
  // The modal teleports to body; stubbed, it renders in place.
  const wrapper = mount(UploadsPane, {
    global: { stubs: { Teleport: true, RegistryPane: true } },
  });
  await flushPromises();
  return wrapper;
}

const radios = (w: Awaited<ReturnType<typeof mountPane>>) =>
  w.findAll<HTMLInputElement>('input[type="radio"]').map((r) => r.element.checked);

describe('UploadsPane', () => {
  beforeEach(() => {
    selectionFails = false;
    h.api.mockReset();
  });

  it('marks the selected uploader with the radio, and Server default when none is', async () => {
    expect(radios(await mountPane(1))).toEqual([true, false, false]);
    expect(radios(await mountPane(null))).toEqual([false, false, true]);
  });

  it('selects the row whose radio was picked', async () => {
    const w = await mountPane(1);
    await w.findAll('input[type="radio"]')[1].setValue(true);
    await flushPromises();
    expect(h.api).toHaveBeenCalledWith('/api/uploaders/selection', {
      method: 'PUT',
      body: { id: 2 },
    });
    expect(radios(w)).toEqual([false, true, false]);

    await w.findAll('input[type="radio"]')[2].setValue(true);
    await flushPromises();
    expect(h.api).toHaveBeenLastCalledWith('/api/uploaders/selection', {
      method: 'PUT',
      body: { id: null },
    });
  });

  it('puts the dot back when the selection is refused', async () => {
    selectionFails = true;
    const w = await mountPane(1);
    await w.findAll('input[type="radio"]')[1].setValue(true);
    await flushPromises();
    expect(radios(w)).toEqual([true, false, false]);
    expect(w.text()).toContain('nope');
  });

  it('offers edit and remove only on a row the user owns', async () => {
    const w = await mountPane();
    const rows = w.findAll('.device');
    expect(rows[0].findAll('button')).toHaveLength(0);
    expect(rows[1].findAll('button').map((b) => b.text())).toEqual(['edit', 'remove']);
    expect(rows[2].findAll('button')).toHaveLength(0);
  });

  it('adds through a modal, sending the type picked there', async () => {
    const w = await mountPane();
    expect(w.find('.modal').exists()).toBe(false);
    await w.find('.add-row button').trigger('click');
    expect(w.find('.modal').exists()).toBe(true);

    await w.find('.modal select').setValue('catbox');
    await w.find('.modal form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenCalledWith('/api/uploaders', {
      method: 'POST',
      body: { driver: 'catbox', label: 'catbox', values: {} },
    });
    expect(w.find('.modal').exists()).toBe(false);
  });

  it('edits through a modal, on the row that was clicked, with no type to pick', async () => {
    const w = await mountPane();
    await w.findAll('.device')[1].find('button').trigger('click');
    expect(w.find('.modal').text()).toContain('edit my zipline');
    expect(w.find('.modal select').exists()).toBe(false);
    expect((w.findAll('.modal input')[1].element as HTMLInputElement).value).toBe(
      'https://z.example',
    );

    await w.find('.modal form').trigger('submit');
    await flushPromises();
    expect(h.api).toHaveBeenCalledWith('/api/uploaders/2', {
      method: 'PATCH',
      body: { label: 'my zipline', values: { url: 'https://z.example' } },
    });
  });
});
