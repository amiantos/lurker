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
