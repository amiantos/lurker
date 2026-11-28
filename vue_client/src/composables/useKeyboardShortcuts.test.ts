// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Message search is Cmd/Ctrl + Shift + F (#1310). Plain Cmd/Ctrl + F is the
// browser's find-in-page and must reach it untouched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
}));

import { useKeyboardShortcuts } from './useKeyboardShortcuts.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { usePinsStore } from '../stores/pins.js';

let wrapper: VueWrapper | null = null;
let onOpenSearch: ReturnType<typeof vi.fn<() => void>>;

function press(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  return e;
}

describe('useKeyboardShortcuts — message search', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    onOpenSearch = vi.fn<() => void>();
    wrapper = mount(
      defineComponent({
        setup() {
          useKeyboardShortcuts({ onOpenSearch });
          return () => h('div');
        },
      }),
    );
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('opens on Cmd/Ctrl + Shift + F, whichever case the key reports', () => {
    for (const init of [
      { key: 'F', metaKey: true, shiftKey: true },
      { key: 'f', ctrlKey: true, shiftKey: true },
    ]) {
      const e = press(init);
      expect(e.defaultPrevented).toBe(true);
    }
    expect(onOpenSearch).toHaveBeenCalledTimes(2);
  });

  it('leaves plain Cmd/Ctrl + F to the browser', () => {
    for (const init of [
      { key: 'f', metaKey: true },
      { key: 'f', ctrlKey: true },
    ]) {
      const e = press(init);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(onOpenSearch).not.toHaveBeenCalled();
  });
});

// "Hide muted channels" (#1034): Alt+arrow walks past a row the sidebar is
// not showing, so stepping never pops a hidden channel into the list.
describe('useKeyboardShortcuts — hidden muted rows', () => {
  let activated: string[] = [];

  beforeEach(() => {
    setActivePinia(createPinia());
    const networks = useNetworksStore();
    const buffers = useBuffersStore();
    networks.networks = [{ id: 1, name: 'libera' }] as never;
    for (const target of ['#a', '#b', '#c']) {
      buffers.buffers[`1::${target}`] = {
        networkId: 1,
        target,
        members: [],
        messages: [],
        unread: 0,
        highlighted: 0,
      } as never;
    }
    networks.activeKey = '1::#a';
    useIgnoresStore().applySnapshot(
      [
        {
          networkId: 1,
          ignoredMasks: [
            {
              id: 1,
              mask: null,
              channels: ['#b'],
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
    activated = [];
    buffers.activate = ((networkId: number, target: string) => {
      activated.push(`${networkId}::${target}`);
    }) as never;
    wrapper = mount(
      defineComponent({
        setup() {
          useKeyboardShortcuts();
          return () => h('div');
        },
      }),
    );
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  const down = () => press({ key: 'ArrowDown', code: 'ArrowDown', altKey: true });
  const hide = () => {
    useNetworksStore().applyHideMuted(1, true);
  };

  it('lands on a muted channel while the network shows them', () => {
    down();
    expect(activated).toEqual(['1::#b']);
  });

  it('walks past it when the network hides them', () => {
    hide();
    down();
    expect(activated).toEqual(['1::#c']);
  });

  it('lands on it again once it has a highlight, or is pinned', () => {
    hide();
    (useBuffersStore().buffers['1::#b'] as { highlighted: number }).highlighted = 1;
    down();
    expect(activated).toEqual(['1::#b']);

    (useBuffersStore().buffers['1::#b'] as { highlighted: number }).highlighted = 0;
    // Pinned, it sorts above #a, so it is one step up.
    usePinsStore().byNetwork = { 1: ['#b'] } as never;
    press({ key: 'ArrowUp', code: 'ArrowUp', altKey: true });
    expect(activated).toEqual(['1::#b', '1::#b']);
  });
});
