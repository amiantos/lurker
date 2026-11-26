// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// A reply out of its buffer (#998) — a search hit, an activity item, a
// bookmark: it quotes what it answers, as the timeline does, and the quote is
// part of the row rather than a control of its own.

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import HistoryMessageRow, { type HistoryMessage } from './HistoryMessageRow.vue';
import { useIgnoresStore } from '../stores/ignores.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useRelayBotsStore } from '../stores/relayBots.js';
import type { ReplyParent } from '../../../shared/replies.js';

const parent = (over: Partial<ReplyParent> = {}): ReplyParent => ({
  id: 1,
  nick: 'alice',
  type: 'message',
  text: 'which \x02branch\x02?',
  userhost: 'alice!~a@host',
  self: false,
  ...over,
});

const reply = (over: Partial<HistoryMessage> = {}): HistoryMessage => ({
  id: 2,
  networkId: 1,
  target: '#chan',
  type: 'message',
  nick: 'bob',
  text: 'alice: the release one',
  time: '2026-09-28T12:00:00.000Z',
  replyTo: { msgid: 'm1', parent: parent() },
  ...over,
});

const mountRow = (message: HistoryMessage) => mount(HistoryMessageRow, { props: { message } });

describe('HistoryMessageRow — replies', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('quotes the answered line, and drops the address it repeats', () => {
    const w = mountRow(reply());
    expect(w.find('.reply-quote .reply-text').text()).toBe('<alice> which branch?');
    expect(w.find('.text').text()).toBe('the release one');
  });

  it('says the answered line is unavailable, and keeps the address', () => {
    const w = mountRow(reply({ replyTo: { msgid: 'm1', parent: null } }));
    expect(w.find('.reply-text').text()).toBe('original message unavailable');
    expect(w.find('.text').text()).toBe('alice: the release one');
  });

  it('won’t quote someone ignored since', () => {
    useIgnoresStore().global = [
      {
        id: 1,
        createdAt: '',
        mask: 'alice!*@*',
        channels: null,
        pattern: null,
        patternKind: 'substr',
        levels: ['ALL'],
        isExcept: false,
        expiresAt: null,
      },
    ];
    const w = mountRow(reply());
    expect(w.find('.reply-text').text()).toBe('original message unavailable');
    expect(w.text()).not.toContain('branch');
    expect(w.find('.text').text()).toBe('alice: the release one');
  });

  // Ignores are about other people: a pattern that matches your own quoted
  // line doesn't take it away.
  it('always quotes your own line', () => {
    useIgnoresStore().global = [
      {
        id: 1,
        createdAt: '',
        mask: null,
        channels: null,
        pattern: 'branch',
        patternKind: 'substr',
        levels: ['ALL'],
        isExcept: false,
        expiresAt: null,
      },
    ];
    const w = mountRow(reply({ replyTo: { msgid: 'm1', parent: parent({ self: true }) } }));
    expect(w.find('.reply-text').text()).toBe('<alice> which branch?');
    // The same line from someone else is hidden by it.
    expect(mountRow(reply()).find('.reply-text').text()).toBe('original message unavailable');
  });

  // #996: as in the timeline, a relayed line is quoted as the person in it.
  it('quotes a relay bot’s line as the person who said it', () => {
    useRelayBotsStore().byKey['1::bridgebot'] = { nick: 'bridgebot', pattern: '' };
    const w = mountRow(
      reply({
        replyTo: {
          msgid: 'm1',
          parent: parent({ nick: 'bridgebot', text: '[Discord] <alice> which branch?' }),
        },
      }),
    );
    expect(w.find('.reply-text').text()).toBe('<alice> [Discord] which branch?');
    expect(w.find('.text').text()).toBe('the release one');
  });

  // The row itself reads as the timeline shows it, so it agrees with its quote.
  it('shows a relayed line as the person who said it', () => {
    useRelayBotsStore().byKey['1::bridgebot'] = { nick: 'bridgebot', pattern: '' };
    const w = mountRow(
      reply({
        nick: 'bridgebot',
        text: '[Discord] <carol> alice: the release one',
        replyTo: { msgid: 'm1', parent: parent() },
      }),
    );
    expect(w.find('.body > .nick').text()).toBe('carol');
    expect(w.find('.text .relay-via').text()).toBe('[Discord]');
    expect(w.find('.text .relay-via').attributes('title')).toBe('Relayed via bridgebot');
    // Her address to alice is the one the quote makes redundant.
    expect(w.find('.text').text()).toBe('[Discord] the release one');
    // Unmarked, the line stays the bot's.
    useRelayBotsStore().byKey = {};
    const raw = mountRow(reply({ nick: 'bridgebot', text: '<carol> hi', replyTo: undefined }));
    expect(raw.find('.body > .nick').text()).toBe('bridgebot');
    expect(raw.find('.text').text()).toBe('<carol> hi');
  });

  it('keeps a /me’s text whole, as the timeline does', () => {
    const w = mountRow(reply({ type: 'action', text: 'alice: waves' }));
    expect(w.find('.reply-quote').exists()).toBe(true);
    expect(w.find('.text').text()).toBe('alice: waves');
  });

  it('shows no quote on a line that isn’t a reply', () => {
    const w = mountRow(reply({ replyTo: undefined }));
    expect(w.find('.reply-quote').exists()).toBe(false);
    expect(w.find('.text').text()).toBe('alice: the release one');
  });

  // The quote knows whose line it is; the open buffer's network nick doesn't
  // (a search hit can come from another network).
  it('colours a quote of your own line as yours, whatever buffer is open', () => {
    useSettingsStore().values = { 'look.nick.self_color': 'rgb(1, 2, 3)' } as never;
    useNetworksStore().states = { 1: { nick: 'me', state: 'connected' } } as never;
    useBuffersStore().ensure(1, '#chan', 9);
    useNetworksStore().activeKey = '1::#chan';
    const mine = mountRow(
      reply({
        networkId: 2,
        replyTo: { msgid: 'm1', parent: parent({ nick: 'me_', self: true }) },
      }),
    );
    const quoted = mine.find('.reply-quote .nick-ref').element as HTMLElement;
    expect(quoted.style.color).toBe('rgb(1, 2, 3)');
    const theirs = mountRow(
      reply({
        networkId: 2,
        replyTo: { msgid: 'm1', parent: parent({ nick: 'me', self: false }) },
      }),
    );
    const other = theirs.find('.reply-quote .nick-ref').element as HTMLElement;
    expect(other.style.color).not.toBe('rgb(1, 2, 3)');
  });

  // A relayed you is judged on the row's network, not the open buffer's.
  it('colours a relayed you by the row’s own network', () => {
    const SELF = 'rgb(1, 2, 3)';
    useSettingsStore().values = { 'look.nick.self_color': SELF } as never;
    // Open buffer: network 1, where you're `me`. The row: network 2, as `me_`.
    useNetworksStore().states = {
      1: { nick: 'me', state: 'connected' },
      2: { nick: 'me_', state: 'connected' },
    } as never;
    useBuffersStore().ensure(1, '#chan', 9);
    useNetworksStore().activeKey = '1::#chan';
    useRelayBotsStore().byKey['2::bridgebot'] = { nick: 'bridgebot', pattern: '' };
    const quoting = (nick: string) =>
      reply({
        networkId: 2,
        nick: 'bridgebot',
        text: `<${nick}> the release one`,
        replyTo: { msgid: 'm1', parent: parent({ nick: 'bridgebot', text: `<${nick}> which?` }) },
      });
    const colourOf = (w: ReturnType<typeof mountRow>, sel: string) =>
      (w.find(sel).element as HTMLElement).style.color;

    const mine = mountRow(quoting('me_'));
    expect(colourOf(mine, '.body > .nick')).toBe(SELF);
    expect(colourOf(mine, '.reply-quote .nick-ref')).toBe(SELF);
    // Your nick on the OTHER network is someone else here.
    const theirs = mountRow(quoting('me'));
    expect(colourOf(theirs, '.body > .nick')).not.toBe(SELF);
    expect(colourOf(theirs, '.reply-quote .nick-ref')).not.toBe(SELF);
  });

  // The row's click jumps to the reply, where the quote is live again.
  it('leaves clicks on the quote to the row', async () => {
    const message = reply();
    const w = mountRow(message);
    const quote = w.find('.reply-quote');
    expect(quote.attributes('role')).toBeUndefined();
    expect(quote.attributes('tabindex')).toBeUndefined();
    await quote.trigger('click');
    expect(w.emitted('jump')).toEqual([[message]]);
    expect(w.findComponent({ name: 'ReplyQuote' }).emitted('jump')).toBeUndefined();
  });
});

// A line's time on its author's clock (#1450), in the timestamp's tooltip.
describe('HistoryMessageRow — author time zone', () => {
  beforeEach(() => setActivePinia(createPinia()));

  // 12:00 UTC on a Monday; 14:00 in Berlin (summer time).
  const plain = (over: Partial<HistoryMessage> = {}) =>
    mountRow(reply({ replyTo: undefined, ...over }));
  const title = (w: ReturnType<typeof mountRow>) => w.find('.time').attributes('title');

  it('says the time where the author is, when their zone is known', () => {
    useNetworksStore().applyUserMetadata(1, 'bob', { tz: 'Europe/Berlin' });
    expect(title(plain())).toMatch(/^bob's time: Mon.*14:00 \(Europe\/Berlin\)$/);
    // By the row's own network, and nothing where no zone is known.
    expect(title(plain({ networkId: 2 }))).toBeUndefined();
    expect(title(plain({ nick: 'carol' }))).toBeUndefined();
  });

  it('has none for a relayed author: the zone belongs to whoever shares their nick here', () => {
    useRelayBotsStore().byKey['1::bridgebot'] = { nick: 'bridgebot', pattern: '' };
    useNetworksStore().applyUserMetadata(1, 'carol', { tz: 'Asia/Tokyo', color: '#00ff00' });
    const w = plain({ nick: 'bridgebot', text: '[Discord] <carol> hi' });
    expect(w.find('.body > .nick').text()).toBe('carol');
    expect(title(w)).toBeUndefined();
    // Nor that person's colour: the relayed carol keeps her hashed one.
    const hashed = plain({ nick: 'carol', networkId: 2 });
    expect((w.find('.body > .nick').element as HTMLElement).style.color).toBe(
      (hashed.find('.body > .nick').element as HTMLElement).style.color,
    );
  });
});
