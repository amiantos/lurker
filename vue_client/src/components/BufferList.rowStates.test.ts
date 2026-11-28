// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// A row's resting states in the mounted sidebar (#1433): muted and not
// joined each mark the row, for a themed colour of its own, and the
// stylesheet's order says which wins.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../composables/useSocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../composables/useSocket.js')>()),
  socketSend: vi.fn<() => boolean>(() => true),
}));

import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useIgnoresStore } from '../stores/ignores.js';
import BufferList from './BufferList.vue';
import bufferListSource from './BufferList.vue?raw';

let wrapper: VueWrapper | null = null;

function classesOf(target: string): string[] {
  const row = wrapper!.findAll('.channels li').find((li) => li.find('.label').text() === target);
  return row ? row.classes() : [];
}

describe('BufferList row states', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const networks = useNetworksStore();
    const buffers = useBuffersStore();
    networks.networks = [{ id: 1, name: 'alpha', collapsed: false }] as never;
    networks.states = { 1: { state: 'connected' } } as never;
    const seed = (target: string, extra: Record<string, unknown> = {}) => {
      buffers.buffers[`1::${target}`] = {
        networkId: 1,
        target,
        members: [],
        messages: [],
        unread: 0,
        highlighted: 0,
        joined: true,
        ...extra,
      } as never;
    };
    seed('#plain');
    seed('#muted', { unread: 4 });
    seed('#parted', { joined: false });
    seed('#both', { joined: false });
    networks.activeKey = '1::#plain';
    useIgnoresStore().applySnapshot(
      [
        {
          networkId: 1,
          ignoredMasks: [
            {
              id: 1,
              mask: null,
              channels: ['#muted', '#both'],
              pattern: null,
              patternKind: 'substr',
              levels: ['NOUNREAD', 'NONOTIFY'],
              isExcept: false,
              expiresAt: null,
              createdAt: '',
            },
          ],
        },
      ],
      [],
    );
    wrapper = mount(BufferList, { attachTo: document.body });
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('marks a muted row, which shows no unread', () => {
    expect(classesOf('#muted')).toContain('muted');
    expect(classesOf('#muted')).not.toContain('unread');
    expect(classesOf('#plain')).not.toContain('muted');
  });

  it('marks a channel that is not joined', () => {
    expect(classesOf('#parted')).toContain('not-joined');
    expect(classesOf('#plain')).not.toContain('not-joined');
  });

  it('marks a row that is both as both, for the stylesheet to rank', () => {
    expect(classesOf('#both')).toEqual(expect.arrayContaining(['muted', 'not-joined']));
  });

  // Equal specificity, so the later rule wins. happy-dom does not cascade, so
  // the order is read.
  it('ranks the colours: name, muted, away, offline, unread, highlighted', () => {
    const css = bufferListSource.split('<style scoped>')[1];
    const at = (rule: string) => {
      const i = css.indexOf(rule);
      if (i < 0) throw new Error(`rule not in the stylesheet: ${rule}`);
      return i;
    };
    const order = [
      '.channels li .label {\n  color: var(--buffer-name);',
      '.channels li.muted .label {\n  color: var(--buffer-muted);',
      '.channels li.peer-away .label {\n  color: var(--fg-muted);',
      // A not-joined channel and an offline DM peer: one rule, one colour.
      '.channels li.not-joined .label,\n.channels li.peer-offline .label {\n  color: var(--buffer-offline);\n  font-style: italic;',
      '.channels li.unread .label {\n  color: var(--buffer-unread);',
      '.channels li.highlighted .label {\n  color: var(--buffer-highlight);',
    ].map(at);
    expect(order).toEqual([...order].toSorted((a, b) => a - b));
    // Nothing after them recolours a DM by its peer: unread shows on a DM as
    // it does on a channel.
    expect(css.slice(order[order.length - 1])).not.toMatch(/peer-(away|offline) \.label/);
    // The row itself is no longer faded: that took the tree guides with it.
    expect(css).not.toMatch(/\.channels li\.not-joined \{\s*opacity/);
  });
});
