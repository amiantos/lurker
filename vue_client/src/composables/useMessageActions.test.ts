// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  BanIcon,
  BookmarkCheckIcon,
  MessageSquareQuoteIcon,
  MessageSquareReplyIcon,
} from '@lucide/vue';
import { useMessageActions, type MessageContext, type MessageLike } from './useMessageActions.js';
import { useContextMenu } from './useContextMenu.js';
import { useBookmarksStore } from '../stores/bookmarks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { useRelayBotsStore } from '../stores/relayBots.js';
import { useRedactionsStore } from '../stores/redactions.js';
import { socketSend } from './useSocket.js';

vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

function makeCtx(): MessageContext {
  return {
    networkId: 1,
    onReply: vi.fn<(message: MessageLike) => void>(),
    onQuote: vi.fn<(message: MessageLike) => void>(),
    onIgnore: vi.fn<(message: MessageLike) => void>(),
  };
}

// A message from someone else, with text and a stable id — the case that yields
// the full action set. Override individual fields per case.
function other(over: Partial<MessageLike> = {}): MessageLike {
  return { id: 42, networkId: 1, nick: 'bob', text: 'hi', self: false, ...over };
}

describe('useMessageActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // The context menu is a module-level singleton — reset between cases.
    useContextMenu().close();
  });

  describe('Delete (#1013)', () => {
    const T = '2026-11-05T00:00:00.000Z';
    const mine = (over: Partial<MessageLike> = {}): MessageLike =>
      other({ self: true, msgid: 'm1', type: 'message', target: '#chan', ...over });
    const keys = (m: MessageLike) =>
      useMessageActions()
        .buildActions(m)
        .map((a) => a.key);

    it('is offered on your own line once the network can delete', () => {
      useNetworksStore().states = { 1: { state: 'connected', canRedact: false } } as never;
      expect(keys(mine())).not.toContain('delete');
      useNetworksStore().states = { 1: { state: 'connected', canRedact: true } } as never;
      expect(keys(mine())).toContain('delete');
      // Never without a msgid to name, nor off a network.
      expect(keys(mine({ msgid: undefined }))).not.toContain('delete');
      useNetworksStore().states = { 1: { state: 'disconnected', canRedact: true } } as never;
      expect(keys(mine())).not.toContain('delete');
    });

    it("is offered on someone else's line only where you hold a prefix mode", () => {
      useNetworksStore().states = {
        1: { state: 'connected', nick: 'me', canRedact: true },
      } as never;
      const theirs = other({ msgid: 'm2', type: 'message', target: '#chan' });
      expect(keys(theirs)).not.toContain('delete');
      const b = useBuffersStore().ensure(1, '#chan', 9);
      b.members = [
        { nick: 'me', modes: [], away: false },
        { nick: 'bob', modes: [], away: false },
      ] as never;
      expect(keys(theirs)).not.toContain('delete');
      b.members = [{ nick: 'Me', modes: ['o'], away: false }] as never;
      expect(keys(theirs)).toContain('delete');
      // A DM has no ops.
      expect(keys(other({ msgid: 'm3', type: 'message', target: 'bob' }))).not.toContain('delete');
    });

    it('leaves a deleted line nothing but its link and bookmark', () => {
      useNetworksStore().states = {
        1: { state: 'connected', canReact: true, canRedact: true },
      } as never;
      const gone = other({
        msgid: 'm4',
        type: 'message',
        target: '#chan',
        text: '',
        redaction: { by: 'bob', time: T },
      });
      expect(keys(gone)).toEqual(['save', 'ignore']);
      const mineGone = mine({ text: '', redaction: { by: 'me', time: T } });
      expect(keys(mineGone)).toEqual(['save']);
    });

    it('reads a live deletion from the store, not only the row', () => {
      useNetworksStore().states = {
        1: { state: 'connected', canReact: true, canRedact: true },
      } as never;
      useRedactionsStore().byMessage.set(42, { by: 'bob', time: T });
      expect(keys(other({ msgid: 'm5', type: 'message', target: '#chan' }))).toEqual([
        'save',
        'ignore',
      ]);
    });

    it('sends the redact only once confirmed', () => {
      useNetworksStore().states = { 1: { state: 'connected', canRedact: true } } as never;
      // No DOM here: the confirm is the browser's, stubbed.
      const confirm = vi.fn<() => boolean>(() => false);
      vi.stubGlobal('window', { confirm });
      try {
        useMessageActions().run('delete', mine(), makeCtx());
        expect(socketSend).not.toHaveBeenCalled();
        confirm.mockReturnValue(true);
        useMessageActions().run('delete', mine(), makeCtx());
        expect(socketSend).toHaveBeenCalledWith({ type: 'redact', messageId: 42 });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('buildActions', () => {
    it('returns reply, quote, copy, copyQuote, save, ignore for another user with text + id', () => {
      const actions = useMessageActions().buildActions(other());
      expect(actions.map((a) => a.key)).toEqual([
        'reply',
        'quote',
        'copy',
        'copyQuote',
        'save',
        'ignore',
      ]);
    });

    it('drops reply + ignore on your own line', () => {
      const actions = useMessageActions().buildActions(other({ self: true }));
      expect(actions.map((a) => a.key)).toEqual(['quote', 'copy', 'copyQuote', 'save']);
    });

    // #1119: Quote is plain text, so it needs nothing from the network — not a
    // msgid, not a reply tag — only words. Your own line and a DM take it where
    // Reply has nothing to offer.
    it('offers quote wherever there is a nick and text, with no network gate', () => {
      const api = useMessageActions();
      const quote = (m: MessageLike) => api.buildActions(m).find((a) => a.key === 'quote');
      expect(quote(other({ id: null, networkId: null }))?.label).toBe('Quote bob');
      expect(quote(other({ self: true, target: 'bob' }))).toBeDefined();
      expect(quote(other({ text: '' }))).toBeUndefined();
      expect(quote(other({ nick: undefined }))).toBeUndefined();
    });

    // MessageList hands over the row as displayed, a relayed line already
    // unwrapped: a bridge's text that only looks like an envelope (a reply with
    // its address stripped) is the bridge's own, and stays so.
    it('names the line as the row shows it, without unwrapping it again', () => {
      useRelayBotsStore().byKey['1::bridge'] = { nick: 'bridge', pattern: '' };
      const actions = useMessageActions().buildActions(
        other({ nick: 'bridge', text: '<bob> hi', type: 'message' }),
      );
      expect(actions.find((a) => a.key === 'quote')?.label).toBe('Quote bridge');
    });

    // #997: on your own line Reply can only make a real reply, so it needs a
    // line that can take one, on a network that would send the tag.
    it('offers reply on your own line that can take a real reply', () => {
      const replyableMine = other({ self: true, msgid: 'm1', type: 'message', target: '#chan' });
      const hasReply = (m: MessageLike) =>
        useMessageActions()
          .buildActions(m)
          .some((a) => a.key === 'reply');
      useNetworksStore().states = { 1: { state: 'connected', canReact: true } } as never;
      const reply = useMessageActions()
        .buildActions(replyableMine)
        .find((a) => a.key === 'reply');
      expect(reply?.label).toBe('Reply to yourself');
      for (const over of [
        { msgid: undefined },
        { e2e: true },
        { type: 'join' },
        { target: ':server:1' },
        { target: '=alice' },
        { id: null },
      ]) {
        // Paired with the case, so a failure names which gate let it through.
        expect({ over, reply: hasReply({ ...replyableMine, ...over }) }).toEqual({
          over,
          reply: false,
        });
      }
      // Ignore stays off your own line either way.
      expect(
        useMessageActions()
          .buildActions(replyableMine)
          .map((a) => a.key),
      ).not.toContain('ignore');

      // No reply tag would go out: nothing a Reply on your own line could do.
      useNetworksStore().states = { 1: { state: 'connected', canReact: false } } as never;
      expect(hasReply(replyableMine)).toBe(false);
      useNetworksStore().states = { 1: { state: 'disconnected', canReact: true } } as never;
      expect(hasReply(replyableMine)).toBe(false);
      // Someone else's line still offers it — the address is the fallback.
      expect(hasReply({ ...replyableMine, self: false })).toBe(true);
    });

    it('puts react first, in the bar and the menu alike', () => {
      useNetworksStore().states = { 1: { state: 'connected', canReact: true } } as never;
      const line = other({ msgid: 'm1', type: 'message', target: '#chan', bufferId: 7 });
      const api = useMessageActions();
      expect(api.buildActions(line).map((a) => a.key)).toEqual([
        'react',
        'reply',
        'quote',
        'copy',
        'copyQuote',
        'link',
        'save',
        'ignore',
      ]);
      expect(api.buildItems(line, makeCtx())[0].label).toBe('React');
    });

    it('offers react on a chat line, on a network that can carry it', () => {
      const line = other({ msgid: 'm1', type: 'message', target: '#chan' });
      const hasReact = (m: MessageLike) =>
        useMessageActions()
          .buildActions(m)
          .some((a) => a.key === 'react');
      useNetworksStore().states = { 1: { state: 'connected', canReact: true } } as never;
      expect(hasReact(line)).toBe(true);
      expect(hasReact({ ...line, type: 'action' })).toBe(true);
      expect(hasReact({ ...line, self: true })).toBe(true);
      for (const over of [
        { type: 'notice' },
        { type: 'join' },
        { msgid: undefined },
        { e2e: true },
        { target: ':server:1' },
        { target: '=alice' },
        { target: undefined },
        { id: null },
        { networkId: null },
      ]) {
        expect({ over, react: hasReact({ ...line, ...over }) }).toEqual({ over, react: false });
      }
      useNetworksStore().states = { 1: { state: 'connected', canReact: false } } as never;
      expect(hasReact(line)).toBe(false);
      useNetworksStore().states = { 1: { state: 'connecting', canReact: true } } as never;
      expect(hasReact(line)).toBe(false);
    });

    // #1101: reply and react are separate answers. A network without echo-message
    // (or whose CLIENTTAGDENY allows only the reply tag) takes a reply but no
    // reaction; one from an older server carries canReact alone, which then
    // stands for both.
    it('gates reply on canReply and react on canReact', () => {
      const mine = other({ self: true, msgid: 'm1', type: 'message', target: '#chan' });
      const keys = (m: MessageLike) =>
        useMessageActions()
          .buildActions(m)
          .map((a) => a.key);
      useNetworksStore().states = {
        1: { state: 'connected', canReact: false, canReply: true },
      } as never;
      expect(keys(mine)).toContain('reply');
      expect(keys(mine)).not.toContain('react');
      useNetworksStore().states = {
        1: { state: 'connected', canReact: true, canReply: false },
      } as never;
      expect(keys(mine)).not.toContain('reply');
      expect(keys(mine)).toContain('react');
      useNetworksStore().states = { 1: { state: 'connected', canReact: true } } as never;
      expect(keys(mine)).toEqual(expect.arrayContaining(['reply', 'react']));
    });

    it('drops copy when there is no text', () => {
      const actions = useMessageActions().buildActions(other({ text: '' }));
      expect(actions.map((a) => a.key)).toEqual(['reply', 'save', 'ignore']);
    });

    it('drops save when there is no stable id', () => {
      const actions = useMessageActions().buildActions(other({ id: null }));
      expect(actions.map((a) => a.key)).toEqual(['reply', 'quote', 'copy', 'copyQuote', 'ignore']);
    });

    it('drops save on a system-buffer line, which has no owning network', () => {
      // networkId null == the app-scoped system buffer. The server can't save
      // these (the ownership check joins through networks), so offering it
      // would be a button that silently does nothing.
      const actions = useMessageActions().buildActions(other({ networkId: null }));
      expect(actions.map((a) => a.key)).toEqual(['reply', 'quote', 'copy', 'copyQuote', 'ignore']);
    });

    it('does not label a system line saved when a real message shares its id', () => {
      // System lines have their own id sequence, so #42 here is NOT the #42 the
      // user bookmarked in a channel.
      useBookmarksStore().noteFromEvents([{ id: 42, bookmarked: true }], 1);
      const actions = useMessageActions().buildActions(other({ networkId: null }));
      expect(actions.find((a) => a.key === 'save')).toBeUndefined();
    });

    it('reflects a saved bookmark in the save label, icon, and active flag', () => {
      // Seeded the way production seeds it: off the `bookmarked` flag riding on
      // a message row, not a connect-burst snapshot.
      useBookmarksStore().noteFromEvents([{ id: 42, bookmarked: true }], 1);
      const save = useMessageActions()
        .buildActions(other())
        .find((a) => a.key === 'save');
      expect(save?.label).toBe('Remove bookmark');
      expect(save?.icon).toBe(BookmarkCheckIcon);
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
      const reply = api.buildItems(m, ctx).find((i) => i.icon === MessageSquareReplyIcon);
      reply?.onClick?.();
      expect(ctx.onReply).toHaveBeenCalledWith(m);
    });

    it('quote item dispatches onQuote through run()', () => {
      const api = useMessageActions();
      const ctx = makeCtx();
      const m = other();
      const quote = api.buildItems(m, ctx).find((i) => i.icon === MessageSquareQuoteIcon);
      quote?.onClick?.();
      expect(ctx.onQuote).toHaveBeenCalledWith(m);
    });

    it('ignore item dispatches onIgnore through run()', () => {
      const api = useMessageActions();
      const ctx = makeCtx();
      const m = other();
      const ignore = api.buildItems(m, ctx).find((i) => i.icon === BanIcon);
      ignore?.onClick?.();
      expect(ctx.onIgnore).toHaveBeenCalledWith(m);
    });

    it('save item does what its label said, though the bookmark moved since (#1136)', () => {
      const api = useMessageActions();
      const bookmarks = useBookmarksStore();
      const setSaved = vi.spyOn(bookmarks, 'setSaved').mockImplementation(() => {});
      const m = other();
      const save = api.buildItems(m, makeCtx()).find((i) => i.label === 'Save message');
      // Saved from another device while this menu sat open.
      bookmarks.noteFromEvents([{ id: 42, bookmarked: true }], 1);
      save?.onClick?.();
      expect(setSaved).toHaveBeenCalledWith(m, true);

      const remove = api.buildItems(m, makeCtx()).find((i) => i.label === 'Remove bookmark');
      bookmarks.noteFromEvents([{ id: 42, bookmarked: false }], 1);
      remove?.onClick?.();
      expect(setSaved).toHaveBeenLastCalledWith(m, false);
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
      expect(menu.state.items.length).toBe(6);
    });

    it('no-ops for a null message', () => {
      const api = useMessageActions();
      const menu = useContextMenu();
      api.openMenu(null, makeCtx(), 1, 2);
      expect(menu.state.open).toBe(false);
    });
  });
});

describe('copy link to message (#744)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useContextMenu().close();
  });

  /** A line in a buffer the server has given an id. */
  function inBuffer(target: string, bufferId: number, over: Partial<MessageLike> = {}) {
    useBuffersStore().ensure(1, target, bufferId);
    return other({ target, ...over });
  }

  it('uses the id the row carries, without a store lookup', () => {
    // Server message events ship bufferId, and buildActions runs for every
    // rendered row — so the common path must not go through findByTarget.
    const actions = useMessageActions().buildActions(
      other({ target: '#chan', bufferId: 7 }), // no buffer registered in the store
    );
    expect(actions.map((a) => a.key)).toContain('link');
  });

  it('offers the link once the buffer has a server id', () => {
    const actions = useMessageActions().buildActions(inBuffer('#chan', 7));
    expect(actions.map((a) => a.key)).toEqual([
      'reply',
      'quote',
      'copy',
      'copyQuote',
      'link',
      'save',
      'ignore',
    ]);
  });

  it('copies an absolute /buffer/<id>?msg=<id> URL', async () => {
    const writeText = vi.fn<(t: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const msg = inBuffer('#chan', 7);
    useMessageActions().run('link', msg, makeCtx());

    // The id form is the whole point: no `#` to percent-encode, and the channel
    // name never reaches the URL.
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/buffer/7?msg=42`);
    vi.unstubAllGlobals();
  });

  it.each([['#chan'], ['&local'], ['+modeless'], ['!12345chan'], ['alice']])(
    'links %s by id, with no name in the URL',
    (target) => {
      const writeText = vi.fn<(t: string) => Promise<void>>(() => Promise.resolve());
      vi.stubGlobal('navigator', { clipboard: { writeText } });

      useMessageActions().run('link', inBuffer(target, 7), makeCtx());

      const url = writeText.mock.calls[0][0];
      expect(url).toBe(`${window.location.origin}/buffer/7?msg=42`);
      // All four channel sigils and a DM nick: none of them reach the URL, so
      // there is no encoding path here to get wrong.
      expect(url).not.toContain(target);
      vi.unstubAllGlobals();
    },
  );

  it('drops the link on a system line, which has no buffer route', () => {
    const actions = useMessageActions().buildActions(
      inBuffer('#chan', 7, { networkId: null, target: ':system:' }),
    );
    expect(actions.map((a) => a.key)).not.toContain('link');
  });

  it('drops the link in a server console, where a jump is refused anyway', () => {
    // useJumpToMessage bails on `:server:` with "Cannot jump in server buffer",
    // so a link there would open the buffer and then toast instead of scrolling.
    const actions = useMessageActions().buildActions(inBuffer(':server:1', 8));
    expect(actions.map((a) => a.key)).not.toContain('link');
  });

  it('drops the link while the buffer has no server id yet', () => {
    // An optimistically created buffer — "Send DM" to a never-DM'd nick — has
    // no row id until the server answers, so there is nothing to address.
    useBuffersStore().ensure(1, 'newpal');
    const actions = useMessageActions().buildActions(other({ target: 'newpal' }));
    expect(actions.map((a) => a.key)).not.toContain('link');
  });

  it('drops the link on a line with no message id', () => {
    const actions = useMessageActions().buildActions(inBuffer('#chan', 7, { id: null }));
    expect(actions.map((a) => a.key)).not.toContain('link');
  });

  it('reaches the context menu too, not just the hover bar', () => {
    const labels = useMessageActions()
      .buildItems(inBuffer('#chan', 7), makeCtx())
      .map((i) => i.label);
    expect(labels).toContain('Copy link to message');
  });
});

describe('copy quote (#1218)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useContextMenu().close();
  });

  function copied(msg: MessageLike): string {
    const writeText = vi.fn<(t: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    useMessageActions().run('copyQuote', msg, makeCtx());
    vi.unstubAllGlobals();
    return writeText.mock.calls[0][0];
  }

  it('copies the text with its author in front', () => {
    expect(copied(other({ type: 'message' }))).toBe('<bob> hi');
  });

  it('writes a /me and a notice the way IRC does', () => {
    expect(copied(other({ type: 'action', text: 'waves' }))).toBe('* bob waves');
    expect(copied(other({ type: 'notice' }))).toBe('-bob- hi');
  });

  // The rules Quote reads a line by (#1119): no formatting codes on the
  // clipboard, a spoiler kept hidden as `||…||`, line breaks folded so the
  // author's name covers the whole line.
  it('copies the text the way Quote reads it', () => {
    expect(copied(other({ type: 'message', text: '\x02hey\x02 \x0301,01secret\x03' }))).toBe(
      '<bob> hey ||secret||',
    );
    expect(copied(other({ type: 'message', text: 'first\nsecond' }))).toBe('<bob> first second');
  });

  it('copies the line as the row shows it, without unwrapping it again', () => {
    useRelayBotsStore().byKey['1::bridge'] = { nick: 'bridge', pattern: '' };
    expect(copied(other({ nick: 'bridge', text: '<bob> hi', type: 'message' }))).toBe(
      '<bridge> <bob> hi',
    );
  });

  it('is offered wherever there is a nick and text, your own line included', () => {
    const api = useMessageActions();
    const has = (m: MessageLike) => api.buildActions(m).some((a) => a.key === 'copyQuote');
    expect(has(other({ self: true, id: null, networkId: null }))).toBe(true);
    expect(has(other({ text: '' }))).toBe(false);
    expect(has(other({ nick: undefined }))).toBe(false);
  });

  it('reaches the context menu too, not just the hover bar', () => {
    const labels = useMessageActions()
      .buildItems(other(), makeCtx())
      .map((i) => i.label);
    expect(labels).toContain('Copy quote');
  });
});
