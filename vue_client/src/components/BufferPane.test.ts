// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import BufferPane from './BufferPane.vue';
import { useBufferKey } from '../composables/useActiveBuffer.js';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => void>(),
  useSocket: vi.fn<() => void>(),
}));

// Stands in for the real message list and reports which buffer its subtree
// resolves to. The provide/inject seam is the whole mechanism the split rests
// on — every child of a pane has to see the PANE's buffer, not the app's active
// one — so the probe asks the same question those children ask.
const KeyProbe = defineComponent({
  name: 'KeyProbe',
  setup() {
    const key = useBufferKey();
    return () => h('div', { class: 'probe' }, key.value ?? 'none');
  },
});

function mountPane(props: { paneKey: string | null; split?: boolean; focused?: boolean }) {
  return mount(BufferPane, {
    props,
    global: {
      stubs: {
        MessageList: KeyProbe,
        MemberList: true,
        StatusBar: true,
        MessageInput: true,
        LinkedText: true,
      },
    },
  });
}

// Two channels on one network, enough for the topic bar to resolve a label.
function seedBuffers() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'libera' } as never];
  buffers.buffers = {
    '1::#ops': { networkId: 1, target: '#ops', kind: 'channel', members: [] } as never,
    '1::#dev': { networkId: 1, target: '#dev', kind: 'channel', members: [] } as never,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  seedBuffers();
});

describe('BufferPane mounting', () => {
  // The shell renders one empty pane before anything is active, so a null key
  // has to be a legal state rather than a crash on first paint.
  it('mounts with no buffer', () => {
    const w = mountPane({ paneKey: null });
    expect(w.find('.buffer-pane').exists()).toBe(true);
    expect(w.find('.probe').text()).toBe('none');
  });

  it('renders the buffer label for its own key', () => {
    const w = mountPane({ paneKey: '1::#ops' });
    expect(w.find('.topic .buffer').text()).toBe('#ops');
  });
});

describe('BufferPane buffer key provision', () => {
  // The bug this guards: a pane that resolved its subtree through
  // networks.activeKey would render the SAME buffer in every pane, which is
  // the singleton behavior the split exists to break.
  it('gives each pane its own buffer, independent of the active one', () => {
    const networks = useNetworksStore();
    networks.activeKey = '1::#ops';

    const a = mountPane({ paneKey: '1::#ops' });
    const b = mountPane({ paneKey: '1::#dev' });

    expect(a.find('.probe').text()).toBe('1::#ops');
    // The active buffer is #ops, but this pane is showing #dev and its subtree
    // has to agree.
    expect(b.find('.probe').text()).toBe('1::#dev');
  });

  // A plain click swaps the focused pane's buffer in place rather than
  // remounting it, so the provided key is a ref the subtree keeps watching.
  it('repoints its subtree when the pane changes buffer', async () => {
    const w = mountPane({ paneKey: '1::#ops' });
    expect(w.find('.probe').text()).toBe('1::#ops');

    await w.setProps({ paneKey: '1::#dev' });
    await nextTick();
    expect(w.find('.probe').text()).toBe('1::#dev');
    expect(w.find('.topic .buffer').text()).toBe('#dev');
  });
});

describe('BufferPane chrome', () => {
  // With one pane there is nothing to maximize away from and closing it would
  // leave an empty frame, so the controls only exist once the frame is split.
  it('hides the pane controls when the frame is not split', () => {
    const w = mountPane({ paneKey: '1::#ops', split: false });
    expect(w.find('.pane-btn').exists()).toBe(false);
    // ...and the nav cluster is present, exactly as in the pre-split shell.
    expect(w.find('.topic-nav').exists()).toBe(true);
  });

  it('shows the pane controls and drops the nav cluster when split', () => {
    const w = mountPane({ paneKey: '1::#ops', split: true });
    expect(w.findAll('.pane-btn')).toHaveLength(2);
    expect(w.find('.topic-nav').exists()).toBe(false);
  });

  it('emits close and maximize from the pane controls', async () => {
    const w = mountPane({ paneKey: '1::#ops', split: true });
    const [maximize, close] = w.findAll('.pane-btn');
    await maximize.trigger('click');
    await close.trigger('click');
    expect(w.emitted('maximize')).toHaveLength(1);
    expect(w.emitted('close')).toHaveLength(1);
  });

  // Focus has to land before the click reaches a button, or a topic-bar action
  // in an unfocused pane would resolve against the previously focused buffer.
  it('emits focus on pointerdown, not on click', async () => {
    const w = mountPane({ paneKey: '1::#ops', split: true });
    await w.find('.buffer-pane').trigger('pointerdown');
    expect(w.emitted('focus')).toHaveLength(1);
  });

  it('marks only the focused pane', () => {
    const focused = mountPane({ paneKey: '1::#ops', split: true, focused: true });
    const other = mountPane({ paneKey: '1::#dev', split: true, focused: false });
    expect(focused.find('.buffer-pane').classes()).toContain('focused');
    expect(other.find('.buffer-pane').classes()).not.toContain('focused');
  });
});
