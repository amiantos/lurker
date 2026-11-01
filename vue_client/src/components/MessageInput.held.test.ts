// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The composer's own ways into an upload (paste, drop) for an account held
// from uploading: each opens the limits modal instead of swallowing the file.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useAuthStore } from '../stores/auth.js';
import { useUploadsStore } from '../stores/uploads.js';
import { useAccountLimits } from '../composables/useAccountLimits.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => void>(),
  socketSendWithAck: vi.fn<() => Promise<{ ok: boolean }>>(() => Promise.resolve({ ok: true })),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const KEY = '1::#chan';
let mounted: VueWrapper[] = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

function seed(uploads: boolean) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet', host: 'irc.lurker.chat' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected' } } as never;
  buffers.buffers[KEY] = { networkId: 1, target: '#chan', members: [], messages: [] } as never;
  networks.activeKey = KEY;
  useRecentBuffersStore().keys = [KEY];
  const auth = useAuthStore();
  auth.user = { id: 1, username: 'held', role: 'user' } as NonNullable<typeof auth.user>;
  auth.setRestrictions({ networks: ['irc.lurker.chat'], uploads });
}

async function composer(): Promise<VueWrapper> {
  const wrapper = mount(MessageInput, { attachTo: document.body });
  mounted.push(wrapper);
  await flush();
  return wrapper;
}

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });

function pasteEvent(file: File): ClipboardEvent {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(e, 'clipboardData', {
    value: { items: [{ kind: 'file', getAsFile: () => file }] },
  });
  return e;
}

function dropEvent(file: File): DragEvent {
  const e = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(e, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  return e;
}

beforeEach(() => {
  setActivePinia(createPinia());
  useAccountLimits().close();
});
afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
});

describe('a composer held from uploading', () => {
  it('answers a pasted image with the limits modal, not an upload', async () => {
    seed(false);
    const upload = vi.spyOn(useUploadsStore(), 'upload').mockResolvedValue(undefined as never);
    const wrapper = await composer();
    wrapper.find('textarea').element.dispatchEvent(pasteEvent(png()));
    await flush();
    expect(useAccountLimits().isOpen.value).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it('answers a dropped file the same way', async () => {
    seed(false);
    const upload = vi.spyOn(useUploadsStore(), 'upload').mockResolvedValue(undefined as never);
    const wrapper = await composer();
    wrapper.find('textarea').element.dispatchEvent(dropEvent(png()));
    await flush();
    expect(useAccountLimits().isOpen.value).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads as before when the account may', async () => {
    seed(true);
    const upload = vi.spyOn(useUploadsStore(), 'upload').mockResolvedValue(undefined as never);
    const wrapper = await composer();
    wrapper.find('textarea').element.dispatchEvent(pasteEvent(png()));
    await flush();
    expect(useAccountLimits().isOpen.value).toBe(false);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
