// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Command aliases (#276) through the real composer: what a typed alias puts on
// the wire, and that /alias and /unalias reach the store.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useRecentBuffersStore } from '../stores/recentBuffers.js';
import { useAliasesStore } from '../stores/aliases.js';
import { socketSend, socketSendWithAck } from '../composables/useSocket.js';
import { useToastsStore } from '../stores/toasts.js';
import { api } from '../api.js';
import { MAX_ALIAS_DEPTH, type Alias } from '../../../shared/aliases.js';
import MessageInput from './MessageInput.vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
  socketSendWithAck: vi.fn<() => Promise<never> | null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

vi.mock('../api.js', () => ({
  api: vi.fn<(path: string, opts?: { method?: string; body?: { body?: string } }) => unknown>(),
}));

let mounted: VueWrapper[] = [];

function seed(aliases: Alias[]) {
  const networks = useNetworksStore();
  const buffers = useBuffersStore();
  networks.networks = [{ id: 7, name: 'testnet' }] as never;
  networks.states = { 7: { nick: 'me' } } as never;
  buffers.buffers['7::#chan'] = {
    networkId: 7,
    target: '#chan',
    members: [],
    messages: [],
  } as never;
  networks.activeKey = '7::#chan';
  useRecentBuffersStore().keys = ['7::#chan'];
  useAliasesStore().aliases = aliases;
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
  return el;
}

/** The raw lines sent, in order. `/quote X` is the plainest command to watch. */
const raws = () =>
  vi
    .mocked(socketSend)
    .mock.calls.map(([payload]) => payload as Record<string, unknown>)
    .filter((p) => p.type === 'raw')
    .map((p) => p.line);

/** What the commands printed into the buffer. */
const printed = () => useBuffersStore().buffers['7::#chan'].messages.map((m) => m.text);

describe('running an alias', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    vi.mocked(socketSend).mockImplementation(() => true);
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('runs each of its commands, in order, with the typed words filled in', async () => {
    seed([{ name: 'pp', body: '/quote PING $1; quote PONG $2-' }]);
    await run('/pp a b c');
    expect(raws()).toEqual(['PING a', 'PONG b c']);
  });

  it('appends the typed words when the body names none', async () => {
    seed([{ name: 'q2', body: '/quote' }]);
    await run('/Q2 PING x');
    expect(raws()).toEqual(['PING x']);
  });

  it('knows where it was run', async () => {
    seed([{ name: 'here', body: '/quote AT $channel $nick $network' }]);
    await run('/here');
    expect(raws()).toEqual(['AT #chan me testnet']);
  });

  it('runs in place of a command of its name, and reaches that command by it', async () => {
    seed([{ name: 'quote', body: '/quote WRAPPED $*' }]);
    await run('/quote PING x');
    expect(raws()).toEqual(['WRAPPED PING x']);
  });

  it('runs another alias from its body', async () => {
    seed([
      { name: 'outer', body: '/inner $1; /quote LAST' },
      { name: 'inner', body: '/quote INNER $1' },
    ]);
    await run('/outer x');
    expect(raws()).toEqual(['INNER x', 'LAST']);
  });

  it('does not go round a loop: a name already running is not an alias', async () => {
    seed([
      { name: 'ping1', body: '/ping2' },
      { name: 'ping2', body: '/ping1 again' },
    ]);
    await run('/ping1');
    // The inner /ping1 is no command of Lurker's, so it goes to the server as typed.
    expect(raws()).toEqual(['ping1 again']);
  });

  it(`stops ${MAX_ALIAS_DEPTH} aliases deep, and says so`, async () => {
    const chain = Array.from({ length: MAX_ALIAS_DEPTH + 1 }, (_, i) => ({
      name: `a${i}`,
      body: `/a${i + 1}`,
    }));
    seed([...chain, { name: `a${MAX_ALIAS_DEPTH + 1}`, body: '/quote END' }]);
    await run('/a0');
    expect(raws()).toEqual([]);
    expect(printed()).toEqual([
      `/a0: /a${MAX_ALIAS_DEPTH} not run, ${MAX_ALIAS_DEPTH} aliases deep.`,
    ]);
  });

  it('runs a chain that is exactly as deep as allowed', async () => {
    const chain = Array.from({ length: MAX_ALIAS_DEPTH - 1 }, (_, i) => ({
      name: `a${i}`,
      body: `/a${i + 1}`,
    }));
    seed([...chain, { name: `a${MAX_ALIAS_DEPTH - 1}`, body: '/quote END' }]);
    await run('/a0');
    expect(raws()).toEqual(['END']);
  });

  it('clears the composer once it has run', async () => {
    seed([{ name: 'pp', body: '/quote PING' }]);
    const el = await run('/pp');
    expect(el.value).toBe('');
  });

  it('keeps the typed line when nothing could be sent', async () => {
    seed([{ name: 'pp', body: '/quote PING; /quote PONG' }]);
    vi.mocked(socketSend).mockImplementation((p) => (p as { type: string }).type !== 'raw');
    const el = await run('/pp');
    expect(el.value).toBe('/pp');
  });

  it('fills $channel with nothing in a server buffer', async () => {
    seed([{ name: 'here', body: '/quote AT [$channel] $nick' }]);
    const networks = useNetworksStore();
    useBuffersStore().buffers['7:::server:7'] = {
      networkId: 7,
      target: ':server:7',
      members: [],
      messages: [],
    } as never;
    networks.activeKey = '7:::server:7';
    await run('/here');
    expect(raws()).toEqual(['AT [] me']);
  });

  it('is held to the limits of the command it runs', async () => {
    // `/me` can't be split across lines; neither can an alias of it.
    seed([{ name: 'emote', body: '/me' }]);
    await run(`/emote ${'long '.repeat(400)}`);
    expect(vi.mocked(socketSendWithAck)).not.toHaveBeenCalled();
    expect(useToastsStore().items.map((t) => t.title)).toEqual(['Action message too long']);
  });

  it('is not run by an escaped slash', async () => {
    seed([{ name: 'pp', body: '/quote PING' }]);
    await run('//pp');
    expect(raws()).toEqual([]);
  });
});

describe('/alias and /unalias', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    vi.mocked(api).mockReset();
  });
  afterEach(() => {
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  it('lists', async () => {
    seed([
      { name: 'j2', body: '/join' },
      { name: 'wii', body: '/whois $1 $1' },
    ]);
    await run('/alias');
    expect(printed()).toEqual(['aliases (2):', '  /j2   /join', '  /wii  /whois $1 $1']);
  });

  it('defines one, and says when it takes the place of a command', async () => {
    seed([]);
    vi.mocked(api).mockResolvedValue({
      alias: { name: 'msg', body: '/notice $1 $2-' },
      created: true,
    });
    await run('/alias /MSG /notice $1 $2-');
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/aliases/msg', {
      method: 'PUT',
      body: { body: '/notice $1 $2-' },
    });
    expect(printed()).toEqual(['alias /msg added, in place of the /msg command']);
    expect(useAliasesStore().aliases).toEqual([{ name: 'msg', body: '/notice $1 $2-' }]);
  });

  it('keeps every command of a body it is given', async () => {
    seed([]);
    vi.mocked(api).mockResolvedValue({
      alias: { name: 'pfft', body: '/msg p hi; /msg f hi' },
      created: true,
    });
    await run('/alias pfft /msg p hi; /msg f hi');
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/aliases/pfft', {
      method: 'PUT',
      body: { body: '/msg p hi; /msg f hi' },
    });
  });

  it('removes one, either way it can be typed', async () => {
    seed([
      { name: 'j2', body: '/join' },
      { name: 'wii', body: '/whois $1 $1' },
    ]);
    vi.mocked(api).mockResolvedValue({ ok: true });
    await run('/alias -j2');
    await run('/unalias WII');
    expect(vi.mocked(api).mock.calls).toEqual([
      ['/api/aliases/j2', { method: 'DELETE' }],
      ['/api/aliases/wii', { method: 'DELETE' }],
    ]);
    expect(printed()).toEqual(['removed alias /j2', 'removed alias /wii']);
    expect(useAliasesStore().aliases).toEqual([]);
  });

  it('refuses a name it cannot take, without asking the server', async () => {
    seed([]);
    await run('/alias unalias /quit');
    await run('/unalias nope');
    expect(vi.mocked(api)).not.toHaveBeenCalled();
    expect(printed()).toEqual([
      "/alias: /unalias can't be replaced",
      '/unalias: no alias called /nope',
    ]);
  });

  it('cannot be replaced by an alias that got in some other way', async () => {
    // The server refuses these names. A list that held one anyway (an import)
    // must not take the two commands that could remove it.
    seed([{ name: 'alias', body: '/quote HIJACKED' }]);
    vi.mocked(api).mockResolvedValue({ ok: true });
    await run('/alias');
    expect(printed()).toEqual(['aliases (1):', '  /alias  /quote HIJACKED']);
    await run('/unalias alias');
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/aliases/alias', { method: 'DELETE' });
    expect(raws()).toEqual([]);
  });

  it('lists by the start of a name on Enter, with no picker in the way', async () => {
    seed([
      { name: 'j2', body: '/join' },
      { name: 'wii', body: '/whois $1 $1' },
    ]);
    const el = await run('/alias wi');
    expect(el.value).toBe('');
    expect(printed()).toEqual(['aliases (1):', '  /wii  /whois $1 $1']);
  });
});
