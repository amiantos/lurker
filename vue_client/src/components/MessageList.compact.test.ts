// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Compact layout: a message that opens an author run carries its time on the
// head line beside the nick, always; continuation rows carry none.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useAvatarSetsStore } from '../stores/avatarSets.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;

function message(id: number, nick: string, minute: number, second = 0) {
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type: 'message',
    nick,
    text: `line ${id}`,
    time: new Date(Date.UTC(2026, 9, 5, 12, minute, second)).toISOString(),
  };
}

function mountCompact(opts: { keepSettings?: boolean } = {}) {
  if (!opts.keepSettings) {
    useSettingsStore().values = {
      'look.message.layout': 'compact',
      'look.message.collapse_timestamps': true,
      'look.nick.show_mode_prefix': true,
    } as never;
  }
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = useBuffersStore().ensure(1, '#chan', 9);
  // dave is a local op; the relayed `dave` below is someone else entirely.
  // bot holds op too, which its notice mark must not wear.
  b.members = [
    { nick: 'dave', modes: ['o'], away: false },
    { nick: 'bot', modes: ['o'], away: false },
  ];
  b.messages = [
    message(1, 'alice', 0),
    message(2, 'alice', 0, 30),
    message(3, 'alice', 2),
    message(4, 'bob', 2, 10),
    { ...message(5, 'carol', 3), type: 'join' },
    { ...message(6, 'dave', 4), relayBot: 'bridge', relaySource: 'github' },
    // A local dave right after the bridged one, inside the author window.
    message(7, 'dave', 4, 20),
    // A bot's run of notices (#1180), then it speaks, then notices again.
    { ...message(8, 'bot', 5), type: 'notice' },
    { ...message(9, 'bot', 5, 10), type: 'notice' },
    message(10, 'bot', 5, 20),
    { ...message(11, 'bot', 5, 30), type: 'notice' },
    { ...message(12, 'bot', 5, 40), type: 'action' },
    { ...message(13, 'bot', 5, 50), type: 'action' },
    // A notice the user sent under a nick they no longer hold (me is `me`).
    { ...message(14, 'oldme', 6), type: 'notice', self: true },
    // The server's own notice: its "nick" is a hostname, nobody to look up.
    { ...message(15, 'irc.example.net', 6, 10), type: 'notice' },
    // The server buffer's own text (numerics, MOTD): no nick at all.
    { ...message(16, '', 7), type: 'motd' },
    { ...message(17, '', 7, 10), type: 'motd' },
    { ...message(18, '', 7, 20), type: 'error' },
    { ...message(19, '', 7, 30), type: 'motd' },
  ] as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
}

function row(id: number) {
  const el = wrapper!.find(`[data-msg-id="${id}"]`).element;
  return {
    headTime: el.querySelector(':scope > .head .time')?.textContent ?? null,
    bodyTime: el.querySelector(':scope > .time')?.textContent ?? null,
  };
}

// An event row (a join) in the compact layout: the time trails the text
// inside the body; the right-edge time track carries nothing readable.
function eventRow(id: number) {
  const el = wrapper!.find(`[data-msg-id="${id}"]`).element;
  return {
    trailing: el.querySelector(':scope > .body .time.trailing')?.textContent ?? null,
    leading: el.querySelector(':scope > .time')?.textContent ?? null,
  };
}

describe('MessageList — compact head timestamp', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('puts the time on the head line of a run and nowhere else on that row', () => {
    mountCompact();
    expect(row(1).headTime).toBeTruthy();
    expect(row(1).bodyTime).toBeNull();
  });

  it('shows no time on continuation rows, even when the minute changes', () => {
    mountCompact();
    expect(row(2)).toEqual({ headTime: null, bodyTime: null });
    expect(row(3)).toEqual({ headTime: null, bodyTime: null });
  });

  it('trails an event row’s time after its text, not at the right edge', () => {
    mountCompact();
    const join = eventRow(5);
    expect(join.trailing).toBeTruthy();
    // The track is still in the DOM (the standard layout reads it) but blank
    // of meaning here: compact hides it.
    expect(join.leading).toBe(join.trailing);
  });

  // The fixture is dated 2026-10-05, which is never today: the date leads.
  it('puts the date before the time on a line from another day, in the set format', () => {
    mountCompact();
    expect(row(1).headTime).toMatch(/^2026-10-05 \d\d:\d\d$/);
    expect(eventRow(5).trailing).toMatch(/^2026-10-05 /);
    wrapper!.unmount();
    useSettingsStore().values = {
      'look.message.layout': 'compact',
      'look.buffer.date_format_compact': '',
    } as never;
    mountCompact({ keepSettings: true });
    expect(row(1).headTime).toMatch(/^\d\d:\d\d$/);
  });

  // A relayed line names where the speaker is from beside the name, as the
  // iOS app does — not in the body, where it reads as part of what was said.
  it('puts a relayed line’s source in the head, next to the nick', () => {
    mountCompact();
    const el = wrapper!.find('[data-msg-id="6"]').element;
    const source = el.querySelector(':scope > .head .relay-source');
    expect(source?.textContent).toBe('github');
    expect(source?.getAttribute('title')).toBe('Relayed via bridge');
    expect(el.querySelector(':scope > .body .relay-via')).toBeNull();
    // No mode glyph on the visitor, though a local dave holds op.
    expect(el.querySelector(':scope > .head .mode-glyph')).toBeNull();
  });

  it('never folds a local nick into a bridged one’s run, or the reverse', () => {
    mountCompact();
    // The local dave gets a head of his own, with his glyph and no source.
    const local = wrapper!.find('[data-msg-id="7"]').element;
    expect(local.querySelector(':scope > .head')).not.toBeNull();
    expect(local.querySelector(':scope > .head .relay-source')).toBeNull();
    expect(local.querySelector(':scope > .head .mode-glyph')?.textContent).toBe('@');
  });

  it('ignores timestamp collapsing: a head in the same minute still shows its time', () => {
    mountCompact();
    // bob's 12:02 matches alice's line above, which collapsing would blank.
    expect(row(4).headTime).toBeTruthy();
  });
});

// Notices in the compact layout (#1180): a head of their own, `-nick-` and the
// time, and a bot's consecutive notices under one head — never shared with
// its messages, as the apps group them.
describe('MessageList — compact notice runs', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  const line = (id: number) => wrapper!.find(`[data-msg-id="${id}"]`).element;
  const head = (id: number) => line(id).querySelector(':scope > .head');

  it('gives a notice the message head: -nick- and the time, no mode glyph', () => {
    mountCompact();
    const h = head(8);
    expect(h).not.toBeNull();
    expect(h!.querySelector('.prefix')?.textContent).toBe('-bot-');
    expect(h!.querySelector('.time')?.textContent).toMatch(/\d\d:\d\d$/);
    expect(h!.querySelector('.mode-glyph')).toBeNull();
    // Plain text, as the standard layout prints the mark: no nick widget to
    // resolve a display name or open a menu.
    expect(h!.querySelector('.nick-ref')).toBeNull();
    expect(line(8).querySelector(':scope > .body')?.textContent).toBe('line 8');
    // Nothing of the standard layout's line-level prefix remains.
    expect(line(8).querySelector(':scope > .prefix')).toBeNull();
    expect(line(8).querySelector('.time.trailing')).toBeNull();
  });

  it('folds a second notice from the same nick under the first head', () => {
    mountCompact();
    expect(line(9).classList.contains('cont-author')).toBe(true);
    expect(head(9)).toBeNull();
    expect(row(9)).toEqual({ headTime: null, bodyTime: null });
  });

  it('starts a new run when the bot speaks, and again when it notices', () => {
    mountCompact();
    // The message head wears the op glyph the notice mark did not.
    const spoke = head(10);
    expect(spoke).not.toBeNull();
    expect(spoke!.querySelector('.prefix')?.textContent).toBe('@bot');
    expect(spoke!.querySelector('.mode-glyph')?.textContent).toBe('@');
    expect(head(11)).not.toBeNull();
    expect(head(11)!.querySelector('.prefix')?.textContent).toBe('-bot-');
  });

  it('colours the whole mark of a self notice in the self colour, under an old nick too', () => {
    mountCompact();
    const mark = head(14)!.querySelector('.prefix') as HTMLElement;
    expect(mark.textContent).toBe('-oldme-');
    expect(mark.style.color).toBe(useSettingsStore().effective('look.nick.self_color'));
    expect(mark.querySelector('[style]')).toBeNull();
  });

  it('gives a notice head a placeholder tile: the colour and a megaphone, no face', () => {
    useSettingsStore().values = {
      'look.message.layout': 'compact',
      'look.message.avatars': true,
      'look.avatars.set': 'ealain',
    } as never;
    // Every bundled tile set, as if its manifest had loaded (no fetch here).
    useAvatarSetsStore().builtinManifests = {
      '/avatars/ealain': { count: 32, ext: 'webp' },
      '/avatars/plain-light': { count: 1, ext: 'webp' },
      '/avatars/plain-dark': { count: 1, ext: 'webp' },
    };
    mountCompact({ keepSettings: true });
    expect(head(15)!.querySelector('.prefix')?.textContent).toBe('-irc.example.net-');
    expect(head(15)!.querySelector('.nick-ref')).toBeNull();
    const tile = line(15).querySelector(':scope > .avatar') as HTMLElement;
    expect(tile.classList.contains('mark-notice')).toBe(true);
    // Never the list's own `.notice` (its dividers' class): a child's root wears the
    // parent's scoped rules, and that one centres, pads and re-homes the tile.
    expect(tile.classList.contains('notice')).toBe(false);
    expect(tile.classList.contains('interactive')).toBe(false);
    expect(tile.querySelector('svg.mark')).not.toBeNull();
    expect(tile.querySelector('img')).toBeNull();
    expect(tile.style.background).not.toBe('');
    // Only the run's first row: the folded notice reserves the gutter, no tile.
    expect(line(9).querySelector(':scope > .avatar')).toBeNull();
    // A message head in the same list draws its face from the set.
    const face = line(10).querySelector(':scope > .avatar') as HTMLElement;
    expect(face.classList.contains('mark-notice')).toBe(false);
    expect(face.querySelector('img')).not.toBeNull();
  });

  // The server buffer's own text (#1180): the network's name over a run of
  // it, as the apps caption it; an error stays a `!!` line of its own.
  it('folds the server’s own text under one head captioned with the network', () => {
    mountCompact();
    const h = head(16)!;
    expect(h.querySelector('.prefix')?.textContent).toBe('testnet');
    expect(h.querySelector('.time')?.textContent).toMatch(/\d\d:\d\d$/);
    expect(line(16).querySelector(':scope > .body')?.textContent).toBe('line 16');
    expect(line(16).querySelector('.time.trailing')).toBeNull();
    expect(line(17).classList.contains('cont-author')).toBe(true);
    expect(head(17)).toBeNull();
    expect(head(18)).toBeNull();
    expect(line(18).querySelector(':scope > .prefix')?.textContent).toBe('!!');
    expect(line(18).querySelector('.time.trailing')).not.toBeNull();
    // The error broke the run: the next server line opens a new head.
    expect(head(19)).not.toBeNull();
  });

  it('colours the server’s head and tile in the network’s colour, as the system buffer does', () => {
    useSettingsStore().values = {
      'look.message.layout': 'compact',
      'look.message.avatars': true,
      'look.avatars.set': 'ealain',
    } as never;
    useAvatarSetsStore().builtinManifests = {
      '/avatars/ealain': { count: 32, ext: 'webp' },
      '/avatars/plain-light': { count: 1, ext: 'webp' },
      '/avatars/plain-dark': { count: 1, ext: 'webp' },
    };
    mountCompact({ keepSettings: true });
    const tile = line(16).querySelector(':scope > .avatar') as HTMLElement;
    expect(tile.classList.contains('mark-server')).toBe(true);
    expect(tile.querySelector('svg.mark')).not.toBeNull();
    const caption = head(16)!.querySelector('.prefix') as HTMLElement;
    expect(caption.style.color).not.toBe('');
    expect(tile.style.background).toContain(caption.style.color);
    expect(tile.getAttribute('aria-label')).toBe('testnet');
    expect(line(18).querySelector(':scope > .avatar')).toBeNull();
    // A self notice under an old nick: the tile agrees with the mark beside
    // it (the row's stored flag, not a guess from the current nick).
    const mine = line(14).querySelector(':scope > .avatar') as HTMLElement;
    expect(mine.style.background).toContain(
      useSettingsStore().effective('look.nick.self_color') as string,
    );
  });

  // A placeholder tile is not a person: a tap on it reaches the row, where a
  // phone opens the message menu from any part of it. The author's tile
  // keeps the tap for the nick menu.
  it('lets a tap on a placeholder tile fall through to the row', () => {
    useSettingsStore().values = {
      'look.message.layout': 'compact',
      'look.message.avatars': true,
      'look.avatars.set': 'ealain',
    } as never;
    useAvatarSetsStore().builtinManifests = {
      '/avatars/ealain': { count: 32, ext: 'webp' },
      '/avatars/plain-light': { count: 1, ext: 'webp' },
      '/avatars/plain-dark': { count: 1, ext: 'webp' },
    };
    mountCompact({ keepSettings: true });
    const reached = (id: number) => {
      const seen = vi.fn<() => void>();
      line(id).addEventListener('click', seen);
      line(id)
        .querySelector(':scope > .avatar')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return seen.mock.calls.length > 0;
    };
    expect(reached(8)).toBe(true);
    expect(reached(16)).toBe(true);
    expect(reached(10)).toBe(false);
  });

  it('leaves actions as single lines that never fold', () => {
    mountCompact();
    for (const id of [12, 13]) {
      expect(head(id)).toBeNull();
      expect(line(id).classList.contains('cont-author')).toBe(false);
      expect(line(id).querySelector(':scope > .prefix')?.textContent).toBe('*');
      expect(line(id).querySelector('.time.trailing')).not.toBeNull();
    }
  });

  it('keeps every notice on its own -nick- line in the standard layout', () => {
    useSettingsStore().values = {
      'look.message.layout': 'auto',
      'look.message.collapse_authors': true,
    } as never;
    mountCompact({ keepSettings: true });
    for (const id of [8, 9, 11]) {
      expect(head(id)).toBeNull();
      expect(line(id).classList.contains('cont-author')).toBe(false);
      expect(line(id).querySelector(':scope > .prefix')?.textContent).toBe('-bot-');
    }
    // The toggle still groups plain messages there.
    expect(line(2).classList.contains('cont-author')).toBe(true);
  });
});
