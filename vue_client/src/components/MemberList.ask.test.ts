// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment happy-dom

// The nicklist's fallback ask for a member list (lurker#1292): only for a buffer
// that is hydrated AND idle. While `history latest` is in flight the reply
// brings the list, and asking as well would send a big room's list twice.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import MemberList from './MemberList.vue';
import { useBuffersStore, resetNamesAsked } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';

vi.mock('../composables/useSocket.js', () => ({ socketSend: vi.fn<() => boolean>(() => true) }));
import { socketSend } from '../composables/useSocket.js';

describe('MemberList — asking for the list', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetNamesAsked();
    vi.mocked(socketSend).mockClear();
    const networks = useNetworksStore();
    networks.states[1] = { state: 'connected', nick: 'me' } as never;
    networks.activeKey = '1::#chan';
    const buffers = useBuffersStore();
    buffers.setMembers(1, '#chan', [], { provisional: true });
    buffers.setJoined(1, '#chan', true);
  });

  it('does not ask while the buffer is still hydrating; asks once it is idle', async () => {
    const buffers = useBuffersStore();
    const buf = buffers.byKey('1::#chan')!;
    buf.loadingHistory = true;
    const wrapper = mount(MemberList);
    await nextTick();
    expect(socketSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'names' }));
    expect(wrapper.text()).toContain('Loading members…');

    // The reply landed without a list (some path that did not carry one); the
    // buffer is hydrated and idle now.
    buf.loadingHistory = false;
    buf.hasMoreOlder = false;
    await nextTick();
    expect(socketSend).toHaveBeenCalledWith({ type: 'names', networkId: 1, target: '#chan' });
    expect(vi.mocked(socketSend).mock.calls.filter((c) => c[0].type === 'names')).toHaveLength(1);
    wrapper.unmount();
  });

  it('shows the list, not loading, for a parted channel with nothing held', async () => {
    const buffers = useBuffersStore();
    buffers.setJoined(1, '#chan', false);
    const wrapper = mount(MemberList);
    await nextTick();
    expect(wrapper.text()).not.toContain('Loading members…');
    expect(socketSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'names' }));
    wrapper.unmount();
  });
});
