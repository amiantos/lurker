// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The member list's glyphs and order follow the network's PREFIX (#1032), and
// the conventional table until the network has sent one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MemberList from './MemberList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import type { PrefixMode } from '../../../shared/channelModes.js';

const WITH_Y: PrefixMode[] = [
  { mode: 'Y', symbol: '!' },
  { mode: 'q', symbol: '~' },
  { mode: 'a', symbol: '&' },
  { mode: 'o', symbol: '@' },
  { mode: 'h', symbol: '%' },
  { mode: 'v', symbol: '+' },
];

let wrapper: VueWrapper | null = null;

function mountWith(members: { nick: string; modes: string[] }[], prefix: PrefixMode[] | null) {
  const networks = useNetworksStore();
  networks.states = {
    1: { nick: 'me', state: 'connected', modeSpec: prefix ? { prefix } : null },
  } as never;
  const b = useBuffersStore().ensure(1, '#chan', 9);
  b.members = members.map((m) => ({ ...m, away: false }));
  b.membersHeld = true; // the list is the room; unheld renders "Loading members…" (lurker#1292)
  networks.activeKey = '1::#chan';
  wrapper = mount(MemberList);
  return wrapper.findAll('li').map((li) => ({
    nick: li.find('.nick').text(),
    glyph: li.find('.prefix').text(),
    classes: li.classes(),
  }));
}

describe('MemberList — PREFIX', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it("ranks and marks a member by the network's own PREFIX", () => {
    const rows = mountWith(
      [
        { nick: 'carol', modes: [] },
        { nick: 'alice', modes: ['o'] },
        { nick: 'yan', modes: ['Y'] },
      ],
      WITH_Y,
    );
    expect(rows.map((r) => [r.nick, r.glyph])).toEqual([
      ['yan', '!'],
      ['alice', '@'],
      ['carol', ''],
    ]);
    expect(rows[0].classes).toContain('mode-owner');
    expect(rows[1].classes).toContain('mode-op');
  });

  it('uses the conventional table before the network sends one', () => {
    const rows = mountWith(
      [
        { nick: 'vic', modes: ['v'] },
        { nick: 'quinn', modes: ['q'] },
      ],
      null,
    );
    expect(rows.map((r) => [r.nick, r.glyph])).toEqual([
      ['quinn', '~'],
      ['vic', '+'],
    ]);
  });
});
