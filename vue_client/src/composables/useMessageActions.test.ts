// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useMessageActions, type MessageContext, type MessageLike } from './useMessageActions.js';
import { useContextMenu } from './useContextMenu.js';
import { useBookmarksStore } from '../stores/bookmarks.js';

function makeCtx(): MessageContext {
  return {
    networkId: 1,
    onReply: vi.fn<(message: MessageLike) => void>(),
    onIgnore: vi.fn<(message: MessageLike) => void>(),
  };
}

// A message from someone else, with text and a stable id — the case that yields
// the full action set. Override individual fields per case.
function other(over: Partial<MessageLike> = {}): MessageLike {
  return { id: 42, nick: 'bob', text: 'hi', self: false, ...over };
}

describe('useMessageActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // The context menu is a module-level singleton — reset between cases.
    useContextMenu().close();
  });

  describe('buildActions', () => {
    it('returns reply, copy, save, ignore for another user with text + id', () => {
      const actions = useMessageActions().buildActions(other());
      expect(actions.map((a) => a.key)).toEqual(['reply', 'copy', 'save', 'ignore']);
    });

    it('drops reply + ignore on your own line', () => {
      const actions = useMessageActions().buildActions(other({ self: true }));
      expect(actions.map((a) => a.key)).toEqual(['copy', 'save']);
    });

    it('drops copy when there is no text', () => {
      const actions = useMessageActions().buildActions(other({ text: '' }));
      expect(actions.map((a) => a.key)).toEqual(['reply', 'save', 'ignore']);
    });

    it('drops save when there is no stable id', () => {
      const actions = useMessageActions().buildActions(other({ id: null }));
      expect(actions.map((a) => a.key)).toEqual(['reply', 'copy', 'ignore']);
    });

    it('reflects a saved bookmark in the save label, icon, and active flag', () => {
      useBookmarksStore().applySnapshot([42]);
      const save = useMessageActions()
        .buildActions(other())
        .find((a) => a.key === 'save');
      expect(save?.label).toBe('Remove bookmark');
      expect(save?.icon).toBe('fa-solid fa-bookmark');
      expect(save?.active).toBe(true);
    });

    it('returns nothing for a null message', () => {
      expect(useMessageActions().buildActions(null)).toEqual([]);
    });
  });

  describe('buildItems parity', () => {
    it('matches buildActions label + icon, in the same order', () => {
      const api = useMessageActions();
      const m = other();
      const actions = api.buildActions(m);
      const items = api.buildItems(m, makeCtx());
      expect(items.map((i) => i.label)).toEqual(actions.map((a) => a.label));
      expect(items.map((i) => i.icon)).toEqual(actions.map((a) => a.icon));
    });

    it('reply item dispatches onReply through run()', () => {
      const api = useMessageActions();
      const ctx = makeCtx();
      const m = other();
      const reply = api.buildItems(m, ctx).find((i) => i.icon?.includes('fa-reply'));
      reply?.onClick?.();
      expect(ctx.onReply).toHaveBeenCalledWith(m);
    });

    it('ignore item dispatches onIgnore through run()', () => {
      const api = useMessageActions();
      const ctx = makeCtx();
      const m = other();
      const ignore = api.buildItems(m, ctx).find((i) => i.icon?.includes('fa-ban'));
      ignore?.onClick?.();
      expect(ctx.onIgnore).toHaveBeenCalledWith(m);
    });

    it('save item toggles the bookmark store through run()', () => {
      const api = useMessageActions();
      const toggle = vi.spyOn(useBookmarksStore(), 'toggle');
      const m = other();
      const save = api.buildItems(m, makeCtx()).find((i) => i.icon?.includes('fa-bookmark'));
      save?.onClick?.();
      expect(toggle).toHaveBeenCalledWith(m);
    });
  });

  describe('openMenu', () => {
    it('opens the shared context menu with the items at the given point', () => {
      const api = useMessageActions();
      const menu = useContextMenu();
      api.openMenu(other(), makeCtx(), 12, 34);
      expect(menu.state.open).toBe(true);
      expect(menu.state.x).toBe(12);
      expect(menu.state.y).toBe(34);
      expect(menu.state.items.length).toBe(4);
    });

    it('no-ops for a null message', () => {
      const api = useMessageActions();
      const menu = useContextMenu();
      api.openMenu(null, makeCtx(), 1, 2);
      expect(menu.state.open).toBe(false);
    });
  });
});
