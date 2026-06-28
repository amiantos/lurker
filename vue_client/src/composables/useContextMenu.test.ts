// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { markRaw } from 'vue';
import { useContextMenu, type ContextMenuItem } from './useContextMenu.js';

// The store is a module-level singleton, so reset between cases. open() compares
// triggerEl by reference (the DOM `contains` check lives in the component). Real
// triggers are DOM elements, which Vue's reactive() leaves un-proxied — so the
// `===` in open() sees the raw node. A plain object WOULD get proxied here and
// break that identity, so the stand-ins are markRaw'd to mirror a DOM element.
const items: ContextMenuItem[] = [{ label: 'A', onClick: () => {} }];
const triggerA = markRaw({}) as unknown as Element;
const triggerB = markRaw({}) as unknown as Element;

describe('useContextMenu toggle', () => {
  beforeEach(() => useContextMenu().close());

  it('opens with a trigger', () => {
    const menu = useContextMenu();
    menu.open(items, 10, 20, triggerA);
    expect(menu.state.open).toBe(true);
    expect(menu.state.triggerEl).toBe(triggerA);
  });

  it('re-opening from the SAME trigger toggles it closed', () => {
    const menu = useContextMenu();
    menu.open(items, 10, 20, triggerA);
    menu.open(items, 10, 20, triggerA);
    expect(menu.state.open).toBe(false);
    expect(menu.state.triggerEl).toBeNull();
  });

  it('opening from a DIFFERENT trigger switches menus, not toggles', () => {
    const menu = useContextMenu();
    menu.open(items, 10, 20, triggerA);
    menu.open(items, 30, 40, triggerB);
    expect(menu.state.open).toBe(true);
    expect(menu.state.triggerEl).toBe(triggerB);
  });

  it('does not toggle when there is no trigger (right-click reopen repositions)', () => {
    const menu = useContextMenu();
    menu.open(items, 10, 20);
    menu.open(items, 30, 40);
    expect(menu.state.open).toBe(true);
    expect(menu.state.x).toBe(30);
    expect(menu.state.y).toBe(40);
  });

  it('a same-trigger re-open still toggles closed even with empty items', () => {
    const menu = useContextMenu();
    menu.open(items, 10, 20, triggerA);
    menu.open([], 10, 20, triggerA);
    expect(menu.state.open).toBe(false);
  });
});
