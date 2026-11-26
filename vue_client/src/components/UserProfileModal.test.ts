// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The modal's no-such-user state (#818).
//
// This file exists because of a bug it would have caught. The failure signal
// was already arriving — irc-framework synthesizes `error: 'not_found'` on
// RPL_ENDOFWHOIS when nothing filled the whois cache, and the component
// already computed `isNotFound` from it — but that computed was only ever
// folded into `isOffline`, so nothing on screen said the lookup had failed.
// The modal rendered a name, a note prompt, and nothing else: exactly what a
// profile we simply have no details for looks like. Only a mounted component
// can see that difference, so this mounts the real one and reads the DOM.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { useWhoisStore } from '../stores/whois.js';
import { useNetworksStore } from '../stores/networks.js';
import { useNickMetadataStore } from '../stores/nickMetadata.js';
import UserProfileModal from './UserProfileModal.vue';

const NET = 1;

function open(nick: string) {
  return mount(UserProfileModal, { props: { nick, networkId: NET } });
}

describe('UserProfileModal — no such user', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('says so when the whois came back not-found', () => {
    useWhoisStore().applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    expect(open('fartboy').text()).toContain("fartboy isn't on this network.");
  });

  it('shows the waiting state instead while the reply is still out', () => {
    // Nothing cached at all is the genuinely-in-the-dark case, and it must not
    // be reported as a miss — the two are what this whole issue is about
    // telling apart.
    const w = open('fartboy');
    expect(w.text()).toContain('Waiting for whois reply');
    expect(w.text()).not.toContain("isn't on this network");
  });

  it('says nothing of the sort once an identity lands', () => {
    useWhoisStore().applyResult(NET, { nick: 'someone', ident: 'u', hostname: 'h.test' });
    const w = open('someone');
    expect(w.text()).not.toContain("isn't on this network");
    expect(w.text()).not.toContain('Waiting for whois reply');
  });

  it('reads the missing nick as offline, not unknown', () => {
    // The header dot is the other half. With no MONITOR data a not-found nick
    // fell through to "Unknown" — the one status we can rule out — which is
    // why the dot could not be left to carry this on its own.
    useWhoisStore().applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    const dot = open('fartboy').find('.dot');
    expect(dot.classes()).toContain('offline');
    expect(dot.attributes('aria-label')).toBe('Offline');
  });

  it('goes back to waiting while a fresh lookup is out over a stale miss', () => {
    // A cached miss is stale the moment a refresh goes out — they may have
    // connected since. Asserting "isn't on this network" through that
    // round-trip is a definite claim about a fact we're in the middle of
    // re-checking, so the in-flight lookup demotes it.
    const whois = useWhoisStore();
    whois.applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    whois.openViewer(NET, 'fartboy');

    const w = open('fartboy');
    expect(w.text()).toContain('Waiting for whois reply');
    expect(w.text()).not.toContain("isn't on this network");
  });

  it('stays quiet for a peer MONITOR already knows is offline', () => {
    // The pre-existing rule, which the in-flight demotion must not trample: if
    // MONITOR has told us they're offline, the header dot carries it and the
    // body lets "Your note" stand on its own. A WHOIS is in flight here — it
    // always is on open — and that alone must not put a spinner on screen.
    const networks = useNetworksStore();
    networks.states[NET] = {
      state: 'connected',
      peerPresence: {
        fartboy: { nick: 'fartboy', state: 'offline', stateAt: null, awayMessage: null },
      },
    } as never;
    useWhoisStore().openViewer(NET, 'fartboy');

    const w = open('fartboy');
    expect(w.text()).not.toContain('Waiting for whois reply');
    expect(w.text()).not.toContain("isn't on this network");
  });

  it('hides Send DM for a nick that is not there', () => {
    // A DM would bounce. This already worked via isOffline; pinned so the
    // presence rework above can't quietly undo it.
    useWhoisStore().applyResult(NET, { nick: 'fartboy', error: 'not_found' });
    expect(open('fartboy').find('button[title="Send DM"]').exists()).toBe(false);
  });

  it('opens the DM on the server, so an empty one can be pinned (#1182)', async () => {
    const { socketSend } = await import('../composables/useSocket.js');
    vi.mocked(socketSend).mockClear();
    useWhoisStore().applyResult(NET, { nick: 'someone', ident: 'u', hostname: 'h.test' });
    await open('someone').find('button[title="Send DM"]').trigger('click');
    expect(socketSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'open-buffer', networkId: NET, target: 'someone' }),
    );
  });
});

// #1032: the channel list peels the network's rank symbols, not a fixed set.
describe('UserProfileModal — channel list', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const channels = (raw: string) => {
    useWhoisStore().applyResult(NET, { nick: 'someone', ident: 'u', channels: raw });
    return open('someone')
      .findAll('.channels .channel')
      .map((b) => [b.find('.ch-prefix').text(), b.text().replace(b.find('.ch-prefix').text(), '')]);
  };

  it("splits on the network's own symbols", () => {
    useNetworksStore().states[NET] = {
      state: 'connected',
      modeSpec: {
        prefix: [
          { mode: 'Y', symbol: '!' },
          { mode: 'o', symbol: '@' },
        ],
      },
    } as never;
    expect(channels('!#lounge @#ops')).toEqual([
      ['!', '#lounge'],
      ['@', '#ops'],
    ]);
  });

  it('leaves a channel type that is also a rank symbol on the name', () => {
    expect(channels('&local @&ops +#voiced')).toEqual([
      ['', '&local'],
      ['@', '&ops'],
      ['+', '#voiced'],
    ]);
  });
});

// Their clock now (#1450), from their time zone or one set on them (#1449).
describe('UserProfileModal — local time', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const row = (w: ReturnType<typeof open>, label: string) => {
    const dt = w.findAll('dt').find((d) => d.text() === label);
    return dt ? (dt.element.nextElementSibling as HTMLElement).textContent!.trim() : null;
  };

  it('shows the time where they are, with the zone', () => {
    useNetworksStore().applyUserMetadata(NET, 'bob', { tz: 'Asia/Tokyo' });
    expect(row(open('bob'), 'Local time')).toMatch(/^\w{3} \d{1,2}:\d\d\s+\(Asia\/Tokyo\)$/);
  });

  it('takes a zone the user set on them, and has no row without one', () => {
    expect(row(open('bob'), 'Local time')).toBeNull();
    useNickMetadataStore().applyUpdate(NET, 'bob', { 'lurker.chat/tz': 'Europe/Berlin' });
    expect(row(open('bob'), 'Local time')).toMatch(/\(Europe\/Berlin\)$/);
  });
});
