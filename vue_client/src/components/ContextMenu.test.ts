// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// On touch, the tap that dismisses the menu does nothing else (#1492). The
// browser turns a touch into a click only if the touchend goes uncancelled, so
// "the tap was swallowed" is read here as "the touchend was cancelled".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ContextMenu from './ContextMenu.vue';
import { useContextMenu } from '../composables/useContextMenu.js';

const menu = useContextMenu();
let wrapper: VueWrapper;
let trigger: HTMLElement;
let elsewhere: HTMLElement;

function pointerDown(target: Element, pointerType: string): void {
  const e = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  target.dispatchEvent(e);
}

// Dispatches a touch-sequence end on `target`; true when it was cancelled.
function touchEnd(target: Element, type = 'touchend', cancelable = true): boolean {
  const e = new Event(type, { bubbles: true, cancelable });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

async function openMenu(): Promise<void> {
  menu.open([{ label: 'A', onClick: () => {} }], 10, 10, trigger);
  // The window listeners attach in a watcher on state.open.
  await nextTick();
}

describe('ContextMenu touch dismissal', () => {
  beforeEach(() => {
    trigger = document.createElement('div');
    elsewhere = document.createElement('div');
    document.body.append(trigger, elsewhere);
    wrapper = mount(ContextMenu, { attachTo: document.body });
  });
  afterEach(() => {
    menu.close();
    wrapper.unmount();
    trigger.remove();
    elsewhere.remove();
  });

  it('a touch outside closes the menu and swallows that tap only', async () => {
    await openMenu();
    pointerDown(elsewhere, 'touch');
    expect(menu.state.open).toBe(false);
    expect(touchEnd(elsewhere)).toBe(true);
    // The next tap is the user's own.
    expect(touchEnd(elsewhere)).toBe(false);
  });

  it('a mouse click outside closes the menu and still lands', async () => {
    await openMenu();
    pointerDown(elsewhere, 'mouse');
    expect(menu.state.open).toBe(false);
    expect(touchEnd(elsewhere)).toBe(false);
  });

  // A message's trigger is its whole row; a nick or link inside it acts on its
  // own click, so the row gets no pass.
  it('a touch on the opening trigger closes and is swallowed too', async () => {
    await openMenu();
    pointerDown(trigger, 'touch');
    expect(menu.state.open).toBe(false);
    expect(touchEnd(trigger)).toBe(true);
  });

  it('a mouse press on the opening trigger is left to its own click', async () => {
    await openMenu();
    pointerDown(trigger, 'mouse');
    expect(menu.state.open).toBe(true);
  });

  // The touched node left the DOM mid-press, so its touchend never reached
  // window. The next gesture must not inherit the swallow.
  it('a tap whose touchend went missing does not eat the next tap', async () => {
    await openMenu();
    pointerDown(elsewhere, 'touch');
    pointerDown(elsewhere, 'touch');
    expect(touchEnd(elsewhere)).toBe(false);
  });

  it('a touch inside the menu is not swallowed', async () => {
    await openMenu();
    const item = document.querySelector('.context-menu .item')!;
    pointerDown(item, 'touch');
    expect(menu.state.open).toBe(true);
    expect(touchEnd(item)).toBe(false);
  });

  it('a cancelled touch disarms without eating the next tap', async () => {
    await openMenu();
    pointerDown(elsewhere, 'touch');
    expect(touchEnd(elsewhere, 'touchcancel')).toBe(false);
    expect(touchEnd(elsewhere)).toBe(false);
  });

  it('a drag that ends uncancelable disarms too', async () => {
    await openMenu();
    pointerDown(elsewhere, 'touch');
    expect(touchEnd(elsewhere, 'touchend', false)).toBe(false);
    expect(touchEnd(elsewhere)).toBe(false);
  });
});
