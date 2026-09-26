// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The pending-reply segment (#993): what the next line sent will answer.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import StatusBar from './StatusBar.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useRepliesStore } from '../stores/replies.js';
import * as overlay from '../composables/useComposerOverlay.js';

const KEY = '1::#chan';

function mountBar(compact = false) {
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'libera' }] as never;
  networks.states[1] = { networkId: 1, channels: [], state: 'connected' } as never;
  networks.activeKey = KEY;
  return mount(StatusBar, {
    props: { compact },
    global: { stubs: { SuggestionStrip: true, MircColorPicker: true, UploadMenu: true } },
  });
}

describe('StatusBar — pending reply', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('shows who and what the next line answers', async () => {
    useRepliesStore().start(KEY, {
      messageId: 7,
      nick: 'alice',
      type: 'message',
      text: 'has \x02anyone\x02 tried\nthe new build?',
    });
    const w = mountBar();
    expect(w.find('.seg.reply').text()).toContain('replying to');
    expect(w.find('.seg.reply').text()).toContain('alice');
    expect(w.find('.reply-excerpt').text()).toBe(': has anyone tried the new build?');
  });

  it('drops the words on the compact bar, keeping the nick', () => {
    useRepliesStore().start(KEY, { messageId: 7, nick: 'alice', type: 'message', text: 'hi' });
    const w = mountBar(true);
    expect(w.find('.reply-label').text()).toBe('');
    expect(w.find('.seg.reply').text()).toContain('alice');
  });

  it('is absent with no reply pending, and for another buffer’s', () => {
    useRepliesStore().start('1::#elsewhere', {
      messageId: 7,
      nick: 'alice',
      type: 'message',
      text: 'hi',
    });
    expect(mountBar().find('.seg.reply').exists()).toBe(false);
  });

  it('cancels through the composer on ×', async () => {
    const cancel = vi.spyOn(overlay, 'cancelComposerReply');
    useRepliesStore().start(KEY, { messageId: 7, nick: 'alice', type: 'message', text: 'hi' });
    const w = mountBar();
    await w.find('.reply-cancel').trigger('click');
    expect(cancel).toHaveBeenCalled();
  });
});
