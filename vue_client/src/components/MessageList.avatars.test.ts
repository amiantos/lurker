// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Avatars in the compact layout (#607): a tile on the first row of an author
// run, none on continuations, nothing at all with the setting off or in the
// standard layout. The tile is the nick's colour; a metadata avatar is the
// server-minted URL and nothing else.

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

function mountWith(values: Record<string, unknown>) {
  useSettingsStore().values = values as never;
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = {
    1: {
      nick: 'me',
      state: 'connected',
      peerPresence: {},
      userMetadata: { bob: { avatarUrl: '/api/link-preview/media/tok.sig' } },
    },
  } as never;
  // The bundled set, as if its manifest had loaded.
  // Every bundled tile set, as if its manifest had loaded (no fetch here).
  useAvatarSetsStore().builtinManifests = {
    '/avatars/ealain': { count: 32, ext: 'webp' },
    '/avatars/plain-light': { count: 1, ext: 'webp' },
    '/avatars/plain-dark': { count: 1, ext: 'webp' },
  };
  const b = useBuffersStore().ensure(1, '#chan', 9);
  b.members = [];
  b.messages = [message(1, 'alice', 0), message(2, 'alice', 0, 30), message(3, 'bob', 2)] as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
}

const avatarOf = (id: number) =>
  wrapper!.find(`[data-msg-id="${id}"]`).element.querySelector(':scope > .avatar');

describe('MessageList — compact avatars', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('draws a tile on the first row of a run and reserves the gutter on the rest', () => {
    mountWith({
      'look.message.layout': 'modern',
      'look.message.avatars': true,
      'look.avatars.set': 'ealain',
    });
    expect(wrapper!.find('.message-list').classes()).toContain('avatars');
    const first = avatarOf(1) as HTMLElement;
    expect(first).not.toBeNull();
    // Generated: the nick colour behind a tile of the bundled set.
    expect(first.style.background).not.toBe('');
    expect(first.querySelector('img')?.getAttribute('src')).toMatch(
      /^\/avatars\/ealain\/\d{3}\.webp$/,
    );
    expect(first.getAttribute('aria-label')).toBe('alice');
    expect(avatarOf(2)).toBeNull();
  });

  it('shows the metadata avatar as the server minted it, never an origin', () => {
    mountWith({
      'look.message.layout': 'modern',
      'look.message.avatars': true,
      'look.avatars.set': 'ealain',
    });
    const bob = avatarOf(3) as HTMLElement;
    expect(bob.querySelector('img')?.getAttribute('src')).toBe('/api/link-preview/media/tok.sig');
    expect(bob.classList.contains('metadata')).toBe(true);
  });

  it('draws the first letter of the shown name for an Initial set', () => {
    mountWith({
      'look.message.layout': 'modern',
      'look.message.avatars': true,
      'look.avatars.set': 'initial',
    });
    useNetworksStore().applyUserMetadata(1, 'alice', { displayName: 'Wonderland Alice' });
    return wrapper!.vm.$nextTick().then(() => {
      const tile = avatarOf(1) as HTMLElement;
      expect(tile.querySelector('img')).toBeNull();
      expect(tile.querySelector('.initial')?.textContent).toBe('W');
    });
  });

  // The ink follows the colour under it, tile by tile: one palette colour
  // here, so every nick's tile is that colour.
  it('inks an Initial letter light on a dark colour and dark on a light one', () => {
    const base = {
      'look.message.layout': 'modern',
      'look.message.avatars': true,
      'look.avatars.set': 'initial',
    };
    mountWith({ ...base, 'look.nick.colors': ['#3163c0'] });
    expect((avatarOf(1) as HTMLElement).querySelector('.initial')?.className).toBe('initial light');
    wrapper!.unmount();
    mountWith({ ...base, 'look.nick.colors': ['#ffd866'] });
    expect((avatarOf(1) as HTMLElement).querySelector('.initial')?.className).toBe('initial dark');
  });

  it("takes a Plain set's silhouette from the directory of the ink that reads", () => {
    const base = {
      'look.message.layout': 'modern',
      'look.message.avatars': true,
      'look.avatars.set': 'plain',
    };
    mountWith({ ...base, 'look.nick.colors': ['#3163c0'] });
    expect((avatarOf(1) as HTMLElement).querySelector('img')?.getAttribute('src')).toBe(
      '/avatars/plain-light/000.webp',
    );
    wrapper!.unmount();
    mountWith({ ...base, 'look.nick.colors': ['#ffd866'] });
    expect((avatarOf(1) as HTMLElement).querySelector('img')?.getAttribute('src')).toBe(
      '/avatars/plain-dark/000.webp',
    );
  });

  it('falls back to the default set for a pointer at a set that is gone', () => {
    mountWith({
      'look.message.layout': 'modern',
      'look.message.avatars': true,
      'look.avatars.set': '999',
    });
    expect((avatarOf(1) as HTMLElement).querySelector('.initial')?.textContent).toBe('A');
  });

  it('draws nothing with the setting off, and nothing in the traditional layout', () => {
    mountWith({ 'look.message.layout': 'modern' });
    expect(wrapper!.find('.message-list').classes()).not.toContain('avatars');
    expect(avatarOf(1)).toBeNull();
    wrapper!.unmount();
    mountWith({ 'look.message.layout': 'traditional', 'look.message.avatars': true });
    expect(wrapper!.find('.message-list').classes()).not.toContain('avatars');
    expect(avatarOf(1)).toBeNull();
  });
});
