// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { socketSend } from '../composables/useSocket.js';
import NickMetadataEditor from './NickMetadataEditor.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useNickMetadataStore } from '../stores/nickMetadata.js';
import { useNickNotesStore } from '../stores/nickNotes.js';
import { useSettingsStore } from '../stores/settings.js';

const send = vi.mocked(socketSend);
const PALETTE = ['#e02020', '#20e020', '#2020e0'];
let wrapper: VueWrapper | null = null;

function open(wire: Record<string, unknown> | null = null, metadata = true) {
  useSettingsStore().values = { 'look.nick.colors': PALETTE } as never;
  if (wire) useNetworksStore().applyUserMetadata(1, 'bob', wire as never);
  wrapper = mount(NickMetadataEditor, {
    props: { networkId: 1, nick: 'bob', metadata },
    attachTo: document.body,
  });
}

const sent = () => send.mock.calls.map((c) => c[0]);
const options = () =>
  wrapper!
    .findAll('.picker option')
    .map((o) => o.text())
    .slice(1);
async function add(label: string) {
  await wrapper!.find('[data-add="metadata"]').trigger('click');
  const select = wrapper!.find('.picker select');
  const option = select.findAll('option').find((o) => o.text() === label)!;
  await select.setValue(option.attributes('value'));
  await nextTick();
}
const button = (text: string) => wrapper!.findAll('button').find((b) => b.text() === text)!;

describe('NickMetadataEditor (#1449)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    send.mockClear();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('offers every field but the avatar to someone with no metadata', async () => {
    open();
    await wrapper!.find('[data-add="metadata"]').trigger('click');
    expect(options()).toEqual(['Display name', 'Nick color', 'Time zone']);
  });

  it('offers to hide an avatar only when there is one', async () => {
    open({ avatarUrl: '/a.png' });
    await add('Avatar');
    await button('Hide avatar').trigger('click');
    expect(sent()).toEqual([
      { type: 'set-nick-metadata', networkId: 1, nick: 'bob', key: 'avatar', value: null },
    ]);
  });

  it('saves a display name, and offers to hide theirs when they set one', async () => {
    open({ displayName: 'Bobby' });
    await add('Display name');
    const input = wrapper!.find('.editor input');
    // Starts from theirs: usually you are fixing it, not replacing it.
    expect((input.element as HTMLInputElement).value).toBe('Bobby');
    await input.setValue('  Robert ');
    await wrapper!.find('.editor').trigger('submit');
    await add('Display name');
    await button('Hide theirs').trigger('click');
    expect(sent().map((m) => m.value)).toEqual(['Robert', null]);
  });

  it('has no hide for a name nobody set', async () => {
    open();
    await add('Display name');
    expect(button('Hide theirs')).toBeUndefined();
    expect(button('Save').attributes('disabled')).toBeDefined();
  });

  it('picks a colour as a palette slot, in one click', async () => {
    open();
    await add('Nick color');
    const swatches = wrapper!.findAll('.swatch.pick');
    expect(swatches).toHaveLength(PALETTE.length);
    await swatches[2].trigger('click');
    expect(sent()).toEqual([
      { type: 'set-nick-metadata', networkId: 1, nick: 'bob', key: 'color', value: '2' },
    ]);
    expect(wrapper!.find('.editor').exists()).toBe(false);
  });

  it('saves a time zone only when it is one, showing the time there', async () => {
    open();
    await add('Time zone');
    const input = wrapper!.find('.editor input');
    await input.setValue('Berlin');
    expect(button('Save').attributes('disabled')).toBeDefined();
    expect(wrapper!.find('.editor small').text()).toMatch(/Not a time zone/);
    // An offset reads as a zone to Intl; the server refuses it, so Save does too.
    await input.setValue('+01:00');
    expect(button('Save').attributes('disabled')).toBeDefined();
    await input.setValue('Europe/Berlin');
    expect(wrapper!.find('.editor small').text()).toMatch(/\d:\d\d.* there, .*\d:\d\d.* here/);
    await wrapper!.find('.editor').trigger('submit');
    expect(sent()).toEqual([
      {
        type: 'set-nick-metadata',
        networkId: 1,
        nick: 'bob',
        key: 'lurker.chat/tz',
        value: 'Europe/Berlin',
      },
    ]);
  });

  // The note is a row of the same list, and both adds are one bar of buttons.
  it('offers both adds as outlined buttons, each only while there is something to add', async () => {
    open();
    const adds = () => wrapper!.findAll('.adds button').map((b) => b.text());
    expect(wrapper!.find('.adds').classes()).toContain('btn-bar');
    expect(adds()).toEqual(['Add note', 'Add metadata']);
    await button('Add note').trigger('click');
    expect(useNickNotesStore().editor).toEqual({ open: true, networkId: 1, nick: 'bob' });

    useNickNotesStore().applyUpdate(1, 'bob', 'lives in Berlin', '2026-11-26T00:00:00Z');
    await nextTick();
    expect(adds()).toEqual(['Add metadata']);
    const note = wrapper!.find('dd[data-key="note"]');
    expect(note.find('.note-body').text()).toBe('lives in Berlin');
    // Edit only: the note's own editor deletes it, a long note isn't one click from gone.
    expect(note.findAll('button').map((b) => b.text())).toEqual(['Edit']);

    useNickMetadataStore().applyUpdate(1, 'bob', {
      'display-name': 'Bob',
      color: '1',
      'lurker.chat/tz': 'Asia/Tokyo',
    });
    await nextTick();
    expect(wrapper!.find('.adds').exists()).toBe(false);
  });

  it('keeps the note alone on our own profile', async () => {
    open(null, false);
    useNickMetadataStore().applyUpdate(1, 'bob', { color: '1' });
    await nextTick();
    expect(wrapper!.findAll('.adds button').map((b) => b.text())).toEqual(['Add note']);
    expect(wrapper!.find('dd[data-key="color"]').exists()).toBe(false);
  });

  // What Reset would bring back is said beside what stands in front of it.
  it('shows theirs beside yours where they set something else', async () => {
    open({ displayName: 'Bobby', color: '#00ff00', tz: 'Europe/Berlin' });
    useNickMetadataStore().applyUpdate(1, 'bob', {
      'display-name': 'Robert',
      color: '0',
      'lurker.chat/tz': 'Europe/Berlin',
    });
    await nextTick();
    const row = (key: string) => wrapper!.find(`dd[data-key="${key}"]`);
    expect(row('display-name').find('.yours').text()).toBe('Robert');
    expect(row('display-name').find('.theirs').text()).toBe('Theirs: Bobby');
    // Their colour as this theme shows it, never the hex they sent.
    const theirs = (row('color').find('.theirs .swatch').element as HTMLElement).style.background;
    expect(theirs).toMatch(/^#[0-9a-f]{6}$/);
    expect(theirs).not.toBe('#00ff00');
    // The same zone on both sides: nothing to tell apart.
    expect(row('lurker.chat/tz').find('.theirs').exists()).toBe(false);
  });

  it('lists what is set, with Reset where they have a value and Remove where not', async () => {
    open({ displayName: 'Bobby' });
    useNickMetadataStore().applyUpdate(1, 'bob', {
      'display-name': null,
      color: '1',
      'lurker.chat/tz': 'Asia/Tokyo',
    });
    await nextTick();
    const row = (key: string) => wrapper!.find(`dd[data-key="${key}"]`);
    expect(row('display-name').find('.yours').text()).toBe('Hidden');
    expect(row('display-name').find('.theirs').text()).toBe('Theirs: Bobby');
    expect(
      row('display-name')
        .findAll('button')
        .map((b) => b.text()),
    ).toEqual(['Edit', 'Reset']);
    expect(row('lurker.chat/tz').find('.yours').text()).toBe('Asia/Tokyo');
    expect(
      row('lurker.chat/tz')
        .findAll('button')
        .map((b) => b.text()),
    ).toEqual(['Edit', 'Remove']);
    expect((row('color').find('.swatch').element as HTMLElement).style.background).toBe(PALETTE[1]);
    await row('color').findAll('button')[1].trigger('click');
    expect(sent()).toEqual([
      { type: 'set-nick-metadata', networkId: 1, nick: 'bob', key: 'color', reset: true },
    ]);
    // Nothing is left to add (no avatar to hide), so it isn't offered.
    expect(wrapper!.find('[data-add="metadata"]').exists()).toBe(false);
  });
});
