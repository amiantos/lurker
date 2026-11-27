// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The quick switcher's query against network names (#1465), at the mounted
// component. switcherSort.test.ts covers the matching rules; this is that the
// switcher uses them, and lists name matches ahead of network matches.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import QuickSwitcher from './QuickSwitcher.vue';

let mounted: VueWrapper[] = [];

function seedStores() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [
    { id: 1, name: 'libera' },
    { id: 2, name: 'oftc' },
  ] as never;
  networks.states = { 1: { nick: 'me' }, 2: { nick: 'me' } } as never;
  const seed: [number, string][] = [
    [1, '#senpai'],
    [1, '#soju'],
    [2, '#libreoffice'],
    [2, '#debian'],
  ];
  for (const [networkId, target] of seed) {
    buffers.buffers[`${networkId}::${target}`] = {
      networkId,
      target,
      members: [],
      messages: [],
    } as never;
  }
  networks.activeKey = '2::#debian';
}

async function type(text: string) {
  const wrapper = mount(QuickSwitcher, { attachTo: document.body });
  mounted.push(wrapper);
  await wrapper.find('input.filter').setValue(text);
  return wrapper
    .findAll('li.row')
    .map((n) => `${n.find('.net').text()}/${n.find('.target').text()}`);
}

describe('QuickSwitcher query matches network names', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seedStores();
  });

  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('lists a network by its name, after the rows that match by their own name', async () => {
    expect(await type('lib')).toEqual([
      'oftc/#libreoffice',
      'libera/[server]',
      'libera/#senpai',
      'libera/#soju',
    ]);
  });

  it('narrows within a network with a second word', async () => {
    expect(await type('lib sen')).toEqual(['libera/#senpai']);
  });

  it('leaves the buffer you are in out of its own network listing', async () => {
    // The active buffer is always the most recent one, so it would otherwise
    // sort to row 0 and Enter would land where you already are.
    const networks = useNetworksStore();
    const recent = useRecentBuffersStore();
    recent.record('1::#soju');
    recent.record('1::#senpai');
    networks.activeKey = '1::#senpai';

    expect(await type('libera')).toEqual(['libera/#soju', 'libera/[server]']);
  });

  it('still finds the buffer you are in by its own name', async () => {
    useNetworksStore().activeKey = '1::#senpai';
    expect(await type('sen')).toEqual(['libera/#senpai']);
  });

  it('still finds a channel by name alone', async () => {
    expect(await type('soju')).toEqual(['libera/#soju']);
  });
});

describe('QuickSwitcher selection', () => {
  let activated: string[] = [];

  beforeEach(() => {
    setActivePinia(createPinia());
    seedStores();
    activated = [];
    useBuffersStore().activate = ((networkId: number, target: string) => {
      activated.push(`${networkId}::${target}`);
    }) as never;
  });

  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
    vi.restoreAllMocks();
  });

  async function open(text: string) {
    const wrapper = mount(QuickSwitcher, { attachTo: document.body });
    mounted.push(wrapper);
    const input = wrapper.find('input.filter');
    await input.setValue(text);
    return { wrapper, input };
  }

  const selectedRow = (wrapper: VueWrapper) => wrapper.find('li.row.active .target').text();

  it('stays on the highlighted row when an unread count reorders the list', async () => {
    // 'lib' lists #libreoffice, then libera's [server], #senpai, #soju.
    const { wrapper, input } = await open('lib');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(selectedRow(wrapper)).toBe('#senpai');

    // A message lands in #soju: it jumps ahead of #senpai in the list.
    (useBuffersStore().buffers['1::#soju'] as { unread: number }).unread = 3;
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('li.row .target').map((n) => n.text())).toEqual([
      '#libreoffice',
      '#soju',
      '[server]',
      '#senpai',
    ]);

    expect(selectedRow(wrapper)).toBe('#senpai');
    await input.trigger('keydown', { key: 'Enter' });
    expect(activated).toEqual(['1::#senpai']);
  });

  it('keeps a valid selection when the highlighted row goes away', async () => {
    const { wrapper, input } = await open('lib');
    for (let i = 0; i < 3; i++) await input.trigger('keydown', { key: 'ArrowDown' });
    expect(selectedRow(wrapper)).toBe('#soju');

    delete useBuffersStore().buffers['1::#soju'];
    await wrapper.vm.$nextTick();

    expect(selectedRow(wrapper)).toBe('#senpai');
  });

  it('leaves an untouched selection on the top row when the list rebuilds', async () => {
    // No query: Cmd+K then Enter goes to whatever is first.
    const { wrapper, input } = await open('');
    expect(selectedRow(wrapper)).toBe('[server]');

    (useBuffersStore().buffers['1::#soju'] as { unread: number }).unread = 3;
    await wrapper.vm.$nextTick();

    expect(selectedRow(wrapper)).toBe('#soju');
    await input.trigger('keydown', { key: 'Enter' });
    expect(activated).toEqual(['1::#soju']);
  });

  it('keeps the highlighted row through a trailing space or a change of case', async () => {
    const { wrapper, input } = await open('lib');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'ArrowDown' });

    await input.setValue('lib ');
    expect(selectedRow(wrapper)).toBe('#senpai');
    await input.setValue('LIB ');
    expect(selectedRow(wrapper)).toBe('#senpai');
  });

  it('does not scroll the list when a rebuild moves the highlighted row', async () => {
    const { wrapper, input } = await open('lib');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'ArrowDown' });
    await wrapper.vm.$nextTick();

    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    (useBuffersStore().buffers['1::#soju'] as { unread: number }).unread = 3;
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(selectedRow(wrapper)).toBe('#senpai');
    expect(scroll).not.toHaveBeenCalled();
  });

  it('ignores the first pointer event, then follows a real move', async () => {
    const { wrapper } = await open('lib');
    const rows = wrapper.findAll('li.row');

    await rows[2].trigger('mousemove', { clientX: 10, clientY: 50 });
    expect(selectedRow(wrapper)).toBe('#libreoffice');

    await rows[2].trigger('mousemove', { clientX: 10, clientY: 52 });
    expect(selectedRow(wrapper)).toBe('#senpai');
  });

  it('returns to the top row, scrolled into view, when the query changes', async () => {
    const { wrapper, input } = await open('lib');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'ArrowDown' });
    await wrapper.vm.$nextTick();

    const scrolled: string[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this.querySelector('.target')?.textContent ?? '');
    });
    await input.setValue('lib s');
    await wrapper.vm.$nextTick();

    // 'lib s' leaves libera's [server], #senpai, #soju.
    expect(selectedRow(wrapper)).toBe('[server]');
    expect(scrolled).toEqual(['[server]']);
  });
});
