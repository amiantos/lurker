// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The status slot of a buffer-list row (#422): one icon per standing fact
// about the buffer, each named for a pointer and for a screen reader.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({ socketSend: vi.fn<() => boolean>(() => true) }));

import BufferStatusIcons from './BufferStatusIcons.vue';
import { useBuffersStore, type Buffer } from '../stores/buffers.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { useE2eChannelsStore } from '../stores/e2eChannels.js';
import { useIgnoresStore } from '../stores/ignores.js';

beforeEach(() => setActivePinia(createPinia()));

function labels(buf: Buffer): string[] {
  const w = mount(BufferStatusIcons, { props: { buf } });
  expect(w.find('.status-icons').exists()).toBe(true);
  return w.findAll('svg').map((svg) => {
    expect(svg.find('title').text()).toBe(svg.attributes('aria-label'));
    return svg.attributes('aria-label')!;
  });
}

describe('BufferStatusIcons', () => {
  it('is an empty slot for a buffer with nothing to say', () => {
    expect(labels(useBuffersStore().ensure(1, '#plain'))).toEqual([]);
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
