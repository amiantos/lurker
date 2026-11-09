// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The two ways a row leaves the uploads browser (#1289). A tile offers ONE of
// them: the trash where deleting destroys the stored bytes (can_delete), and
// "remove from list" everywhere else — no delete handle, a destination the
// user removed, a moderation tombstone. The second also appears beside a failed
// delete's reason, so a row that only LOOKS deletable is never stuck.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

type ApiOpts = { method?: string } | undefined;
const api = vi.fn<(url: string, opts?: ApiOpts) => Promise<unknown>>();
vi.mock('../api.js', () => ({ api: (url: string, opts?: ApiOpts) => api(url, opts) }));

import RecentUploadsModal from './RecentUploadsModal.vue';
import { useUploadsStore, type UploadItem } from '../stores/uploads.js';

const confirm = vi.fn<(message?: string) => boolean>(() => true);

function row(id: number, over: Partial<UploadItem> = {}): UploadItem {
  return {
    id,
    url: `https://x.test/${id}.webp`,
    filename: `${id}.webp`,
    mime: 'image/webp',
    favorite: false,
    can_delete: true,
    ...over,
  };
}

// The list request answers with `rows`; every write (DELETE, PUT) succeeds unless
// a test queues a rejection ahead of it.
async function open(rows: UploadItem[]) {
  api.mockImplementation(async (_url, opts) => (opts?.method ? { ok: true } : { items: rows }));
  const wrapper = mount(RecentUploadsModal, {
    attachTo: document.body,
    global: { stubs: { DccFilesTab: true, WordBackdrop: true } },
  });
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof open>>;
const tile = (w: Wrapper, id: number) =>
  w.findAll('.tile').find((t) => t.text().includes(`${id}.webp`))!;
const writes = () =>
  api.mock.calls.filter(([, opts]) => opts?.method).map(([url, opts]) => `${opts!.method} ${url}`);

describe('RecentUploadsModal — taking a row off the list', () => {
  let wrapper: Wrapper | null = null;

  beforeEach(() => {
    setActivePinia(createPinia());
    api.mockReset();
    confirm.mockReset().mockReturnValue(true);
    vi.stubGlobal('confirm', confirm);
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.unstubAllGlobals();
  });

  it('offers the trash or remove-from-list, never both', async () => {
    wrapper = await open([
      row(1),
      row(2, { can_delete: false }),
      row(3, { removed: true, can_delete: false }),
    ]);

    const deletable = tile(wrapper, 1);
    expect(deletable.find('.act.delete').exists()).toBe(true);
    expect(deletable.find('.act.forget').exists()).toBe(false);

    // A destination the user removed, or a host with no delete handle.
    const orphan = tile(wrapper, 2);
    expect(orphan.find('.act.delete').exists()).toBe(false);
    expect(orphan.find('.act.forget').exists()).toBe(true);

    // A tombstone keeps nothing the trash could destroy, so it gets the same exit.
    const tombstone = tile(wrapper, 3);
    expect(tombstone.find('.act.delete').exists()).toBe(false);
    expect(tombstone.find('.act.forget').exists()).toBe(true);
    expect(tombstone.find('.act.forget').classes()).not.toContain('delete');
  });

  it('removes the record and leaves the file, after saying so', async () => {
    wrapper = await open([row(2, { can_delete: false })]);

    await tile(wrapper, 2).find('.act.forget').trigger('click');
    await flushPromises();

    expect(confirm).toHaveBeenCalledTimes(1);
    const message = confirm.mock.calls[0][0]!;
    expect(message).toContain('Remove "2.webp" from your uploads?');
    expect(message).toContain('The file stays where it is');
    // The record route, never the delete.
    expect(writes()).toEqual(['DELETE /api/uploads/2/record']);
    expect(wrapper.findAll('.tile')).toHaveLength(0);
    expect(useUploadsStore().recent).toEqual([]);
  });

  it('does not tell a tombstone’s owner the file stays — it is already gone', async () => {
    wrapper = await open([row(3, { removed: true, can_delete: false })]);

    await tile(wrapper, 3).find('.act.forget').trigger('click');
    await flushPromises();

    expect(confirm.mock.calls[0][0]).toBe('Remove "3.webp" from your uploads?');
    expect(writes()).toEqual(['DELETE /api/uploads/3/record']);
  });

  it('sends nothing when the confirm is declined', async () => {
    wrapper = await open([row(2, { can_delete: false })]);
    confirm.mockReturnValue(false);

    await tile(wrapper, 2).find('.act.forget').trigger('click');
    await flushPromises();

    expect(writes()).toEqual([]);
    expect(wrapper.findAll('.tile')).toHaveLength(1);
  });

  it('shows why a remove failed and keeps the row', async () => {
    wrapper = await open([row(2, { can_delete: false })]);
    api.mockRejectedValueOnce(new Error('this upload is still being recorded — try again shortly'));

    await tile(wrapper, 2).find('.act.forget').trigger('click');
    await flushPromises();

    expect(wrapper.find('p.error').text()).toContain('still being recorded');
    expect(wrapper.findAll('.tile')).toHaveLength(1);
    // The spinner is released: the tile can be tried again.
    expect(tile(wrapper, 2).find('.act.forget').attributes('disabled')).toBeUndefined();
  });

  it('offers remove-from-list beside a failed delete, and it works', async () => {
    wrapper = await open([row(1)]);
    api.mockRejectedValueOnce(new Error('catbox delete failed: file doesn’t exist?'));

    // The tile itself only has the trash; the delete fails and the row stays.
    await tile(wrapper, 1).find('.act.delete').trigger('click');
    await flushPromises();
    expect(writes()).toEqual(['DELETE /api/uploads/1']);
    expect(wrapper.find('p.error').text()).toContain('catbox delete failed');
    expect(wrapper.findAll('.tile')).toHaveLength(1);

    const fallback = wrapper.find('p.error button.link');
    expect(fallback.text()).toBe('Remove it from the list instead');

    await fallback.trigger('click');
    await flushPromises();

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1][0]).toContain('The file stays where it is');
    expect(writes()).toEqual(['DELETE /api/uploads/1', 'DELETE /api/uploads/1/record']);
    expect(wrapper.findAll('.tile')).toHaveLength(0);
    expect(wrapper.find('p.error').exists()).toBe(false);
  });

  it('has no fallback for a plain delete that succeeded, or before any error', async () => {
    wrapper = await open([row(1), row(2)]);
    expect(wrapper.find('p.error').exists()).toBe(false);

    await tile(wrapper, 1).find('.act.delete').trigger('click');
    await flushPromises();

    expect(writes()).toEqual(['DELETE /api/uploads/1']);
    expect(wrapper.findAll('.tile')).toHaveLength(1);
    expect(wrapper.find('p.error').exists()).toBe(false);
  });

  it('drops the fallback when a later error replaces the delete’s reason', async () => {
    wrapper = await open([row(1), row(2)]);
    api.mockRejectedValueOnce(new Error('delete failed'));

    await tile(wrapper, 1).find('.act.delete').trigger('click');
    await flushPromises();
    expect(wrapper.find('p.error button.link').exists()).toBe(true);

    // A star on ANOTHER row fails. The error line now explains that failure, so
    // the "remove it" button must not sit beside it pointing at row 1.
    api.mockRejectedValueOnce(new Error('could not star'));
    await tile(wrapper, 2).find('.act.star').trigger('click');
    await flushPromises();

    expect(wrapper.find('p.error').text()).toContain('could not star');
    expect(wrapper.find('p.error button.link').exists()).toBe(false);
    expect(wrapper.findAll('.tile')).toHaveLength(2);
  });
});
