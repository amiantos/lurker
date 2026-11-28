// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The input bar's "try /commands" is a one-time hint (#1494): it shows until
// the account has run /commands, which writes a per-account flag, and never
// again.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';
import { useViewport } from '../composables/useViewport.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<never> | null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const SEEN = 'hints.commands_seen';

let mounted: VueWrapper[] = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

function seed(key: string) {
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me' } } as never;
  for (const target of ['#mango', ':server:1']) {
    useBuffersStore().buffers[`1::${target}`] = {
      networkId: 1,
      target,
      members: [],
      messages: [],
    } as never;
  }
  networks.activeKey = key;
}

async function composer() {
  const wrapper = mount(MessageInput, { attachTo: document.body });
  mounted.push(wrapper);
  await flush();
  return wrapper.find('textarea').element as HTMLTextAreaElement;
}

async function run(el: HTMLTextAreaElement, line: string) {
  el.value = line;
  el.setSelectionRange(line.length, line.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  await flush();
}

describe('the /commands hint', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seed('1::#mango');
  });
  afterEach(() => {
    for (const w of mounted) w.unmount();
    mounted = [];
    useViewport().isMobile.value = false;
  });

  it('shows until /commands has been run', async () => {
    useSettingsStore().loaded = true;
    expect((await composer()).placeholder).toBe('try /commands');
  });

  it('is gone once the flag is set, the server buffer included', async () => {
    const settings = useSettingsStore();
    settings.loaded = true;
    settings.values = { [SEEN]: true };
    const el = await composer();
    expect(el.placeholder).toBe('');
    useNetworksStore().activeKey = '1:::server:1';
    await flush();
    expect(el.placeholder).toBe('');
  });

  // Before the settings land, "unset" also means "not fetched yet".
  it('stays out until the settings have loaded', async () => {
    expect((await composer()).placeholder).toBe('');
  });

  // Mobile channels carry the nick there and never showed the hint. The
  // server buffer leads with the hint, then falls back to the nick like them.
  it('on mobile, only the server buffer shows the hint, then the nick', async () => {
    useViewport().isMobile.value = true;
    const settings = useSettingsStore();
    settings.loaded = true;
    const el = await composer();
    expect(el.placeholder).toBe('me');
    useNetworksStore().activeKey = '1:::server:1';
    await flush();
    expect(el.placeholder).toBe('try /commands');
    settings.values = { [SEEN]: true };
    await flush();
    expect(el.placeholder).toBe('me');
  });

  it('a /commands run before the settings load still sets the flag', async () => {
    const settings = useSettingsStore();
    const write = vi.spyOn(settings, 'setValue').mockResolvedValue();
    await run(await composer(), '/commands');
    expect(write.mock.calls).toEqual([[SEEN, true]]);
  });

  it('running /commands sets the flag, once', async () => {
    const settings = useSettingsStore();
    settings.loaded = true;
    const write = vi.spyOn(settings, 'setValue').mockImplementation(async (key, value) => {
      settings.values = { ...settings.values, [key]: value };
    });
    const el = await composer();
    await run(el, '/commands');
    expect(write.mock.calls).toEqual([[SEEN, true]]);
    expect(el.placeholder).toBe('');
    await run(el, '/commands');
    expect(write).toHaveBeenCalledTimes(1);
  });
});
