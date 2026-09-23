// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The channel modal (#727), mounted against real stores with the socket mocked:
// what it draws from the network's modeSpec, who may edit, what Save sends,
// and how a list tab loads and then keeps itself current.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
  socketSendWithAck: vi.fn<
    (payload: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown> | null
  >(() => Promise.resolve({ ok: true, data: { ok: true, lines: 1 } })),
}));
vi.mock('../api.js', () => ({
  api: vi.fn<(url: string) => Promise<unknown>>(() =>
    Promise.resolve({
      networks: [{ id: 1, channels: [{ name: '#chan', key: 'hunter2' }] }],
    }),
  ),
}));

import { socketSend, socketSendWithAck } from '../composables/useSocket.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useNetworksStore } from '../stores/networks.js';
import { parseModeSpec } from '../../../shared/channelModes.js';
import ChannelModal from './ChannelModal.vue';

function seed({ myModes = ['o'], modes = 'ntl' } = {}) {
  const networks = useNetworksStore();
  networks.states[1] = {
    networkId: 1,
    channels: [],
    nick: 'me',
    // solanum: q is a quiet list, MODES=4, TOPICLEN=390.
    modeSpec: parseModeSpec({
      CHANMODES: ['eIbq', 'k', 'flj', 'CFLMPQRSTcgimnprstuz'],
      PREFIX: [
        { mode: 'o', symbol: '@' },
        { mode: 'v', symbol: '+' },
      ],
      MODES: '4',
      TOPICLEN: '390',
    }),
  };
  const buffers = useBuffersStore();
  buffers.ensure(1, '#chan');
  buffers.setMembers(1, '#chan', [
    { nick: 'me', modes: myModes, away: false },
    { nick: 'alice', modes: [], away: false },
  ]);
  buffers.setTopic(1, '#chan', 'hello', { setBy: 'alice', setAt: '2026-09-23T10:00:00.000Z' });
  buffers.setChannelModes(1, '#chan', modes, { modeParams: { l: '50' }, createdAt: null });
  return { buffers };
}

const open = () => mount(ChannelModal, { props: { networkId: 1, target: '#chan' } });
const checkbox = (w: ReturnType<typeof open>, letter: string) =>
  w
    .findAll('.modes li')
    .find((r) => r.find('code').text() === `+${letter}`)
    ?.find('input[type="checkbox"]');

describe('ChannelModal', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(socketSend).mockClear();
    // Reset, not clear: a test's unconsumed mockImplementationOnce would
    // otherwise answer the next test's first call.
    vi.mocked(socketSendWithAck).mockReset();
    vi.mocked(socketSendWithAck).mockImplementation(() =>
      Promise.resolve({ ok: true, data: { ok: true, lines: 1 } }),
    );
  });

  it("draws every mode the network has, checked as the channel's are", () => {
    seed();
    const w = open();
    expect((checkbox(w, 'n')!.element as HTMLInputElement).checked).toBe(true);
    expect((checkbox(w, 'm')!.element as HTMLInputElement).checked).toBe(false);
    // A letter with no well-known meaning still gets its row.
    expect(checkbox(w, 'C')?.exists()).toBe(true);
    expect(w.text()).toContain('Set by alice');
    expect(w.findAll('[role="tab"]').map((t) => t.text())).toEqual([
      'Settings',
      'Bans',
      'Exceptions',
      'Invites',
      'Quiets',
    ]);
  });

  it('lets a non-op read but not edit, showing only the modes that are set', () => {
    seed({ myModes: [], modes: 'nt' });
    const w = open();
    expect(checkbox(w, 'n')!.attributes('disabled')).toBeDefined();
    expect(checkbox(w, 'm')).toBeUndefined();
    expect(checkbox(w, 'C')).toBeUndefined();
    expect(w.text()).toContain('Only channel operators can change modes.');
    // +t and no rank: the topic is read-only too, so there's nothing to save.
    expect(w.find('textarea').exists()).toBe(false);
    expect(w.find('button[type="submit"]').exists()).toBe(false);
  });

  it('saves only what changed, as one set-channel-modes', async () => {
    seed();
    const w = open();
    await checkbox(w, 'm')!.setValue(true);
    await checkbox(w, 't')!.setValue(false);
    await w.find('form.modal-form').trigger('submit');
    await flushPromises();
    expect(socketSendWithAck).toHaveBeenCalledWith({
      type: 'set-channel-modes',
      networkId: 1,
      channel: '#chan',
      changes: [
        { sign: '+', letter: 'm' },
        { sign: '-', letter: 't' },
      ],
    });
  });

  it('sends a changed topic as one line', async () => {
    seed();
    const w = open();
    await w.find('textarea').setValue('new\ntopic');
    await w.find('form.modal-form').trigger('submit');
    await flushPromises();
    expect(socketSend).toHaveBeenCalledWith({
      type: 'raw',
      networkId: 1,
      line: 'TOPIC #chan :new topic',
    });
  });

  it("shows the channel's error rows that arrive after a Save", async () => {
    const { buffers } = seed();
    const w = open();
    await checkbox(w, 'm')!.setValue(true);
    await w.find('form.modal-form').trigger('submit');
    await flushPromises();
    buffers.pushMessage({
      id: 99,
      networkId: 1,
      target: '#chan',
      type: 'error',
      text: "You're not a channel operator.",
      time: new Date().toISOString(),
    });
    await flushPromises();
    expect(w.find('.error').text()).toBe("You're not a channel operator.");
  });

  it("fills the key from the network config, masked, and doesn't resend it untouched", async () => {
    seed({ modes: 'ntk' });
    const w = open();
    await flushPromises();
    const key = w.find('input[aria-label="+k value"]');
    expect(key.attributes('type')).toBe('password');
    expect((key.element as HTMLInputElement).value).toBe('hunter2');
    await w.find('button[aria-label="Show key"]').trigger('click');
    expect(key.attributes('type')).toBe('text');
    // Nothing touched, nothing to save.
    expect(w.find('button[type="submit"]').attributes('disabled')).toBeDefined();
  });

  it('loads a list tab with a long ACK timeout, then patches it from live MODE rows', async () => {
    const { buffers } = seed();
    vi.mocked(socketSendWithAck).mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        data: { ok: true, entries: [{ mask: '*!*@old', setBy: 'op', setAt: null }] },
      }),
    );
    const w = open();
    await w
      .findAll('[role="tab"]')
      .find((t) => t.text() === 'Bans')!
      .trigger('click');
    await flushPromises();
    expect(socketSendWithAck).toHaveBeenCalledWith(
      { type: 'get-mode-list', networkId: 1, channel: '#chan', letter: 'b' },
      { timeoutMs: 35_000 },
    );
    expect(w.findAll('.mask').map((m) => m.text())).toEqual(['*!*@old']);

    buffers.pushMessage({
      id: 100,
      networkId: 1,
      target: '#chan',
      type: 'mode',
      nick: 'op',
      time: '2026-09-23T11:00:00.000Z',
      modes: [
        { mode: '+b', param: '*!*@new', kind: 'list' },
        { mode: '-b', param: '*!*@old', kind: 'list' },
      ],
    });
    await flushPromises();
    expect(w.findAll('.mask').map((m) => m.text())).toEqual(['*!*@new']);
  });

  it("says why a list couldn't be read", async () => {
    seed({ myModes: [] });
    vi.mocked(socketSendWithAck).mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        error: 'refused',
        data: { ok: false, error: 'refused', numeric: '482', text: 'nope' },
      }),
    );
    const w = open();
    await w
      .findAll('[role="tab"]')
      .find((t) => t.text() === 'Exceptions')!
      .trigger('click');
    await flushPromises();
    expect(w.text()).toContain('Only channel operators can see this list.');
  });
});
