// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The status icons by a buffer's name in the topic bar (#422, #646): one per
// standing fact about the buffer, each named for a pointer and a screen reader.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({ socketSend: vi.fn<() => boolean>(() => true) }));

import BufferStatusIcons from './BufferStatusIcons.vue';
import { useBuffersStore, type Buffer } from '../stores/buffers.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { useE2eChannelsStore } from '../stores/e2eChannels.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useNetworksStore } from '../stores/networks.js';

beforeEach(() => setActivePinia(createPinia()));

function labels(buf: Buffer): string[] {
  const w = mount(BufferStatusIcons, { props: { buf } });
  return w.findAll('svg').map((svg) => {
    expect(svg.find('title').text()).toBe(svg.attributes('aria-label'));
    return svg.attributes('aria-label')!;
  });
}

describe('BufferStatusIcons', () => {
  it('renders nothing for a buffer with nothing to say', () => {
    const w = mount(BufferStatusIcons, { props: { buf: useBuffersStore().ensure(1, '#plain') } });
    expect(w.find('.status-icons').exists()).toBe(false);
  });

  describe('a DM whose peer is logged in (#646)', () => {
    const connected = (extra: Record<string, unknown>) =>
      useNetworksStore().applySnapshot([
        { networkId: 1, channels: [], state: 'connected', ...extra },
      ]);

    it('says which account, on the server\u2019s word', () => {
      connected({ peerAccounts: { bob: 'bobacct' } });
      const buffers = useBuffersStore();
      expect(labels(buffers.ensure(1, 'Bob'))).toEqual(['Logged in as bobacct']);
      expect(labels(buffers.ensure(1, 'carol'))).toEqual([]);
    });

    it('follows a peer-account frame in and out', () => {
      connected({ peerAccounts: {} });
      const networks = useNetworksStore();
      const bob = useBuffersStore().ensure(1, 'bob');
      networks.applyPeerAccount(1, 'Bob', 'bobacct');
      expect(labels(bob)).toEqual(['Logged in as bobacct']);
      networks.applyPeerAccount(1, 'bob', null);
      expect(labels(bob)).toEqual([]);
    });

    it('shows nothing while the network is not connected', () => {
      connected({ peerAccounts: { bob: 'bobacct' }, state: 'disconnected' });
      expect(labels(useBuffersStore().ensure(1, 'bob'))).toEqual([]);
    });

    it('never marks a channel that shares the name', () => {
      connected({ peerAccounts: { '#bob': 'x' } });
      expect(labels(useBuffersStore().ensure(1, '#bob'))).toEqual([]);
    });

    it('falls back to a held member list on a server that does not say', () => {
      connected({});
      const buffers = useBuffersStore();
      buffers.setMembers(1, '#one', [{ nick: 'bob', modes: [], away: false, account: 'bobacct' }]);
      expect(labels(buffers.ensure(1, 'bob'))).toEqual(['Logged in as bobacct']);
    });
  });

  it('marks an encrypted channel', () => {
    useE2eChannelsStore().applySnapshot([{ networkId: 1, e2eChannels: ['#secret'] }]);
    expect(labels(useBuffersStore().ensure(1, '#secret'))).toEqual(['End-to-end encrypted']);
    expect(labels(useBuffersStore().ensure(2, '#secret'))).toEqual([]);
  });

  it('marks an always-notify channel', () => {
    useChannelNotifyStore().applyChange(1, '#loud', { notifyAlways: true });
    expect(labels(useBuffersStore().ensure(1, '#loud'))).toEqual(['Always notify']);
  });

  it('marks a muted channel and a muted DM, not one that is only un-notified', () => {
    const rule = (id: number, channel: string, levels: string[]) => ({
      id,
      mask: '*',
      levels,
      channels: [channel],
      pattern: null,
      patternKind: null,
      isExcept: false,
      expiresAt: null,
    });
    useIgnoresStore().applySnapshot(
      [
        {
          networkId: 1,
          ignoredMasks: [
            rule(1, '#busy', ['NOUNREAD', 'NONOTIFY']),
            rule(2, 'carol', ['NOUNREAD', 'NONOTIFY']),
            rule(3, '#quiet', ['NONOTIFY']),
          ],
        },
      ],
      [],
    );
    const buffers = useBuffersStore();
    expect(labels(buffers.ensure(1, '#busy'))).toEqual(['Muted']);
    expect(labels(buffers.ensure(1, 'carol'))).toEqual(['Muted']);
    expect(labels(buffers.ensure(1, '#quiet'))).toEqual([]);
  });

  it('shows every state that holds, encryption first', () => {
    useE2eChannelsStore().applySnapshot([{ networkId: 1, e2eChannels: ['#all'] }]);
    useChannelNotifyStore().applyChange(1, '#all', { notifyAlways: true });
    expect(labels(useBuffersStore().ensure(1, '#all'))).toEqual([
      'End-to-end encrypted',
      'Always notify',
    ]);
  });
});
