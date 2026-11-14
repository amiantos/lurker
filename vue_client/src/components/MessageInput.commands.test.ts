// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Slash-command completion through the real composer (#533): which menu a
// command line opens, what a pick inserts, and what Enter means while one is
// up. The grammar itself is covered in lib/commands/completion.test.ts.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { SYSTEM_KEY } from '../lib/virtualBuffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { socketSend } from '../composables/useSocket.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<never> | null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

const CHANNELS = ['#apple', '#mango', '&local'];
const MEMBERS = ['alice', 'alexis', 'bob', 'me'];

function seed() {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me' } } as never;
  for (const target of CHANNELS) {
    buffers.buffers[`1::${target}`] = {
      networkId: 1,
      target,
      members: MEMBERS.map((nick) => ({ nick, modes: [], away: false })),
      messages: [],
    } as never;
  }
  networks.activeKey = '1::#mango';
  useRecentBuffersStore().keys = ['1::#mango'];
  return networks;
}

let mounted: VueWrapper[] = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

async function composer() {
  const wrapper = mount(MessageInput, { attachTo: document.body });
  mounted.push(wrapper);
  await flush();
  return wrapper.find('textarea').element as HTMLTextAreaElement;
}

async function type(el: HTMLTextAreaElement, value: string) {
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

async function key(el: HTMLTextAreaElement, name: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  await flush();
  await flush();
}

// The rows of whichever popover is open, nearest the input first (the list
// renders bottom-up).
const rows = () =>
  [...document.querySelectorAll('.vertical-popover .row')]
    .map((r) => r.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .toReversed();
// What went to the server, less the composer's own housekeeping.
const HOUSEKEEPING = new Set(['input-history-add', 'draft-clear', 'draft-set', 'typing']);
const sent = () =>
  vi
    .mocked(socketSend)
    .mock.calls.map(([payload]) => payload as Record<string, unknown>)
    .filter((p) => !HOUSEKEEPING.has(String(p.type)));

describe('slash-command completion', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    seed();
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('lists commands as the verb is typed, usage and summary on each row', async () => {
    const el = await composer();
    await type(el, '/jo');
    expect(rows()).toEqual(['/join <#chan> [key]join a channel']);
    await type(el, '/');
    expect(rows().slice(0, 3)).toEqual([
      '/join <#chan> [key]join a channel',
      '/msg <nick> [text]open a DM and send',
      '/me <text>emote in the current buffer',
    ]);
  });

  it('Tab completes the verb and the next argument opens straight away', async () => {
    const el = await composer();
    await type(el, '/jo');
    await key(el, 'Tab');
    expect(el.value).toBe('/join ');
    // The channel picker, current channel first.
    expect(rows()).toEqual(['#mango', '&local', '#apple']);
  });

  it('a channel argument needs no sigil, and reaches every kind of channel', async () => {
    const el = await composer();
    await type(el, '/join ap');
    expect(rows()).toEqual(['#apple']);
    await type(el, '/part &lo');
    expect(rows()).toEqual(['&local']);
    await key(el, 'Tab');
    expect(el.value).toBe('/part &local ');
  });

  it('a nick argument opens the nick picker without an @', async () => {
    const el = await composer();
    await type(el, '/msg al');
    expect(rows()).toEqual(['alexis', 'alice']);
    await key(el, 'Enter');
    expect(el.value).toBe('/msg alexis ');
    expect(sent()).toEqual([]);
  });

  it('offers subcommands, each with its own form', async () => {
    const el = await composer();
    await type(el, '/dcc c');
    expect(rows()).toEqual([
      '/dcc cancel <id>stop a transfer',
      '/dcc clear [id]take finished transfers off the list; your files stay',
      '/dcc chat [-passive] [-secure] <nick>open a direct peer-to-peer chat, in a =nick buffer',
      '/dcc close chat <nick>end a direct chat, or decline one',
    ]);
    await type(el, '/dcc ch');
    await key(el, 'Tab');
    expect(el.value).toBe('/dcc chat ');
    expect(rows()).toContain('alice');
  });

  it('offers setting keys with their current value, then the values a key takes', async () => {
    const el = await composer();
    await type(el, '/set input.suggestion');
    expect(rows()).toEqual(['input.suggestion_strip_on_desktopfalse']);
    await key(el, 'Tab');
    expect(el.value).toBe('/set input.suggestion_strip_on_desktop ');
    expect(rows()).toEqual(['on', 'off']);
  });

  it('Enter sends a command that is already whole', async () => {
    const el = await composer();
    await type(el, '/away');
    expect(rows()).toContain('/away [-all] [-one] [msg]set away (no msg clears)');
    await key(el, 'Enter');
    expect(sent()).toEqual([{ type: 'away', message: '', networkId: 1 }]);
    expect(el.value).toBe('');
  });

  it('Enter completes a command that is not', async () => {
    const el = await composer();
    await type(el, '/aw');
    await key(el, 'Enter');
    expect(el.value).toBe('/away ');
    expect(sent()).toEqual([]);
  });

  it('Enter sends when the argument is a whole nick, or not started', async () => {
    const el = await composer();
    await type(el, '/kick bob');
    expect(rows()).toEqual(['bob']);
    await key(el, 'Enter');
    expect(sent()).toEqual([{ type: 'raw', networkId: 1, line: 'KICK #mango bob' }]);

    vi.mocked(socketSend).mockClear();
    await type(el, '/part ');
    expect(rows()).toEqual(['#mango', '&local', '#apple']);
    await key(el, 'Enter');
    expect(sent()).toEqual([{ type: 'part', networkId: 1, channel: '#mango', reason: '' }]);
  });

  it('Tab still completes in place once the picker is dismissed', async () => {
    const el = await composer();
    await type(el, '/dcc c');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(rows()).toEqual([]);
    await key(el, 'Tab');
    expect(el.value).toBe('/dcc cancel ');
    // The pick looked again and found nothing to offer for an id, so the next
    // Tab is still the same walk.
    await key(el, 'Tab');
    expect(el.value).toBe('/dcc clear ');
  });

  it('leaves free text to the ordinary pickers', async () => {
    const el = await composer();
    await type(el, '/me waves at @al');
    expect(rows()).toEqual(['alexis', 'alice']);
    await type(el, '/me hello');
    expect(rows()).toEqual([]);
  });

  it('completes commands in a server buffer, where nothing else completes', async () => {
    const networks = useNetworksStore();
    useBuffersStore().buffers['1:::server:1'] = {
      networkId: 1,
      target: ':server:1',
      members: [],
      messages: [],
    } as never;
    networks.activeKey = '1:::server:1';
    const el = await composer();
    await type(el, '/jo');
    await key(el, 'Tab');
    expect(el.value).toBe('/join ');
    expect(rows()).toEqual(['#mango', '&local', '#apple']);
  });

  it('lists only what runs without a network in the system buffer', async () => {
    useNetworksStore().activeKey = SYSTEM_KEY;
    const el = await composer();
    await type(el, '/');
    const listed = rows().join('\n');
    expect(listed).toContain('/network [list]');
    expect(listed).not.toContain('/join');
    await type(el, '/netw');
    await key(el, 'Tab');
    expect(el.value).toBe('/network ');
    expect(rows()[0]).toBe('/network listyour networks');
  });
});
