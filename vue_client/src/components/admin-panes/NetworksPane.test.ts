// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const api = vi.fn<(path: string, opts?: { method?: string; body?: unknown }) => Promise<any>>();
vi.mock('../../api.js', () => ({ api: (...a: [string]) => api(...a) }));

import NetworksPane from './NetworksPane.vue';

const corp = {
  id: 7,
  name: 'Corp',
  host: 'irc.corp.example',
  port: 6697,
  tls: true,
  saslLikelyRequired: false,
  channels: ['#general'],
  tags: ['gaming'],
  users: 120,
  channelCount: null,
  enabled: true,
  position: 0,
};

async function mountPane() {
  api.mockResolvedValue({ presets: [corp], allowUserDefined: true });
  const wrapper = mount(NetworksPane);
  await flushPromises();
  return wrapper;
}
const field = (wrapper: ReturnType<typeof mount>, label: string) =>
  wrapper
    .findAll('form label')
    .find((l) => l.find('span').text() === label)!
    .find('input');

beforeEach(() => {
  setActivePinia(createPinia());
  api.mockReset();
});

describe('Admin → Networks: card details', () => {
  it('lists what a preset was given', async () => {
    const wrapper = await mountPane();
    expect(wrapper.find('.row').text()).toContain('gaming · 120 users');
  });

  it('adds a network with tags and counts, a blank count as none', async () => {
    const wrapper = await mountPane();
    await field(wrapper, 'Name').setValue('New');
    await field(wrapper, 'Host').setValue('irc.new.example');
    await field(wrapper, 'Tags').setValue('linux, tech');
    await field(wrapper, 'Channels').setValue('14');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    const post = api.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(post[1]!.body).toMatchObject({
      name: 'New',
      tags: ['linux', 'tech'],
      users: null,
      channelCount: 14,
    });
    expect(post[1]!.body).not.toHaveProperty('enabled');
  });

  it('edits a listed preset through the form, and can clear a count', async () => {
    const wrapper = await mountPane();
    await wrapper.find('.row .btn-bar button:not(.bad)').trigger('click');
    expect(wrapper.find('form h3').text()).toBe('Edit Corp');
    expect(field(wrapper, 'Tags').element.value).toBe('gaming');
    expect(field(wrapper, 'Users').element.value).toBe('120');

    await field(wrapper, 'Users').setValue('');
    await field(wrapper, 'Tags').setValue('gaming, linux');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    const patch = api.mock.calls.find((c) => c[1]?.method === 'PATCH')!;
    expect(patch[0]).toBe('/api/admin/networks/7');
    expect(patch[1]!.body).toMatchObject({ tags: ['gaming', 'linux'], users: null });
    // Offered-or-not is the row's checkbox, not the form's to send.
    expect(patch[1]!.body).not.toHaveProperty('enabled');
    expect(wrapper.find('form h3').text()).toBe('Add a network');
  });
});
