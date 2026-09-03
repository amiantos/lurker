// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// `/network cert` through the real composer (#459).
//
// This file exists for the failure it catches, which is silence. The command
// runs inside a try/catch that reports what the server said — but a promise
// RETURNED out of a try block settles after the block has exited, so a `return`
// without `await` skips that catch entirely, and the only call site is
// `void runNetwork(...)`. A rejected request then produced no output at all:
// the user typed a command, the server refused it, and the buffer stayed empty.
// Only driving the command end to end can see that.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => void>(),
  socketSendWithAck: vi.fn<() => Promise<never> | null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const DIGEST = {
  sha256: 'd'.repeat(64),
  sha1: 'e'.repeat(40),
  sha512: 'f'.repeat(128),
  subject: 'CN=me',
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: '2036-01-01T00:00:00.000Z',
};

let mounted: VueWrapper[] = [];

function seed(networkExtra: Record<string, unknown> = {}) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet', ...networkExtra }] as never;
  networks.states = { 1: { nick: 'me' } } as never;
  buffers.buffers['1::#chan'] = {
    networkId: 1,
    target: '#chan',
    members: [],
    messages: [],
  } as never;
  networks.activeKey = '1::#chan';
  useRecentBuffersStore().keys = ['1::#chan'];
  return { networks, buffers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function run(command: string) {
  const wrapper = mount(MessageInput, { attachTo: document.body });
  mounted.push(wrapper);
  await flush();
  const el = wrapper.find('textarea').element as HTMLTextAreaElement;
  el.value = command;
  el.setSelectionRange(command.length, command.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  await flush();
}

const output = () =>
  (useBuffersStore().buffers['1::#chan'] as unknown as { messages: { text: string }[] }).messages
    .map((m) => m.text)
    .join('\n');

describe('/network cert', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
    vi.restoreAllMocks();
  });

  it('says what the server said when the request is refused', async () => {
    const { networks } = seed();
    vi.spyOn(networks, 'attachCertificate').mockRejectedValue(
      new Error('a client certificate can only be used on a TLS network — enable TLS first'),
    );
    await run('/network cert testnet new');
    expect(output()).toContain('failed');
    expect(output()).toContain('enable TLS first');
  });

  it('prints the new fingerprint and how to register it', async () => {
    const { networks } = seed();
    vi.spyOn(networks, 'attachCertificate').mockResolvedValue(DIGEST);
    await run('/network cert testnet new');
    expect(output()).toContain(DIGEST.sha512);
    expect(output()).toContain('NickServ CERT ADD');
  });

  it('shows a stored fingerprint without touching the server', async () => {
    const { networks } = seed({ client_cert: DIGEST });
    const attach = vi.spyOn(networks, 'attachCertificate');
    await run('/network cert testnet');
    expect(output()).toContain(DIGEST.sha256);
    expect(output()).toContain(DIGEST.sha1);
    expect(output()).toContain(DIGEST.sha512);
    expect(attach).not.toHaveBeenCalled();
  });

  it('points at the fix when the stored certificate is the problem', async () => {
    seed({ client_cert: { unusable: true } });
    await run('/network cert testnet');
    expect(output()).toMatch(/can't be read/);
    expect(output()).toContain('remove');
  });

  it('says a network has none rather than printing nothing', async () => {
    seed();
    await run('/network cert testnet');
    expect(output()).toContain('no client certificate');
  });
});
