// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The profile editor (#1189): what it shows, and what Save sends — only the
// fields that changed, so a key set elsewhere and left alone isn't claimed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

type Call = { url: string; method?: string; body?: unknown };
const calls: Call[] = [];
let reply: unknown = null;
const multipart: Array<{ url: string; fields: Record<string, unknown> }> = [];
vi.mock('../api.js', () => ({
  api: (url: string, opts: { method?: string; body?: unknown } = {}) => {
    calls.push({ url, ...opts });
    return Promise.resolve(reply);
  },
  apiMultipart: (url: string, fd: FormData) => {
    multipart.push({ url, fields: Object.fromEntries(fd.entries()) });
    return Promise.resolve({ id: 5, url: 'https://cdn.example/me.webp', mime: 'image/webp' });
  },
}));

import ProfileEditorModal from './ProfileEditorModal.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useProfileEditor } from '../composables/useProfileEditor.js';
import { useConfigStore } from '../stores/config.js';

const NET = 7;
const LIMITS = { maxSubs: 10, maxKeys: 10, maxValueBytes: null, beforeConnect: false };

function setNetwork(state: Record<string, unknown>) {
  const networks = useNetworksStore();
  networks.networks = [{ id: NET, name: 'ergo' } as never, { id: 8, name: 'other' } as never];
  networks.states[NET] = { networkId: NET, channels: [], ...state } as never;
}

async function open() {
  useProfileEditor().open(NET);
  const wrapper = mount(ProfileEditorModal, { props: { networkId: NET }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

const input = (wrapper: Awaited<ReturnType<typeof open>>, title: string) =>
  wrapper
    .findAll('label')
    .find((l) => l.find('.title').text() === title)!
    .find('input');

describe('profile editor', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    calls.length = 0;
    multipart.length = 0;
  });

  it("fills saved keys, the server's for the rest, and saves what changed or isn't saved", async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = {
      values: { 'display-name': 'Saved Name' },
      // A saved unset stays empty, whatever the server still has.
      unset: ['status'],
      live: { 'display-name': 'Saved Name', pronouns: 'from halloy', status: 'stale' },
      avatarPreview: null,
    };
    const wrapper = await open();
    expect((input(wrapper, 'Display name').element as HTMLInputElement).value).toBe('Saved Name');
    expect((input(wrapper, 'Pronouns').element as HTMLInputElement).value).toBe('from halloy');
    expect((input(wrapper, 'Status').element as HTMLInputElement).value).toBe('');

    await input(wrapper, 'Status').setValue('  lunch ');
    await input(wrapper, 'Display name').setValue('');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)).toEqual({
      url: `/api/networks/${NET}/metadata`,
      method: 'PUT',
      // The server's pronouns, shown and kept, are saved now too; a saved
      // field left alone, and an empty one never saved, aren't sent.
      body: { values: { 'display-name': null, pronouns: 'from halloy', status: 'lunch' } },
    });
    expect(useProfileEditor().networkId.value).toBeNull();
  });

  it('publishes a colour as #rrggbb and shows what this theme makes of it (#1452)', async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: {}, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    const colour = wrapper.find('input[aria-label="Nick color"]');
    const save = () => wrapper.find('button[type="submit"]');

    await colour.setValue('red');
    expect(wrapper.find('.field small').text()).toMatch(/Not a color/);
    expect(save().attributes('disabled')).toBeDefined();

    await colour.setValue(' #0F0 ');
    expect(wrapper.find('.field small').text()).toMatch(/^Shows as\s+in this theme\.$/);
    // Fitted to the theme, not the hex typed.
    const chip = (wrapper.find('.swatch.chip').element as HTMLElement).style.background;
    expect(chip).not.toBe('');
    expect(chip).not.toBe('#00ff00');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)?.body).toEqual({ values: { color: '#00ff00' } });
  });

  it('saves a time zone only when it is one, and never fills it in unasked (#1450)', async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: {}, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    const zone = input(wrapper, 'Time zone');
    expect((zone.element as HTMLInputElement).value).toBe('');

    await zone.setValue('Berlin');
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
    await zone.setValue('Europe/Berlin');
    expect(wrapper.text()).toMatch(/\d:\d\d.* there now\./);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(calls.at(-1)?.body).toEqual({ values: { timezone: 'Europe/Berlin' } });
  });

  it('lets a colour saved as any text by an older version through until it is touched', async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: { color: 'red' }, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    await input(wrapper, 'Status').setValue('lunch');
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined();
    await wrapper.find('input[aria-label="Nick color"]').setValue('blue');
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
  });

  it('leaves a colour it did not touch as it was saved, whatever its spelling', async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: { color: '#ABC' }, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    await input(wrapper, 'Status').setValue('lunch');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    // Not re-sent as #aabbcc: another session may have changed it since.
    expect(calls.at(-1)?.body).toEqual({ values: { status: 'lunch' } });
  });

  it("fills in this device's zone when asked", async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: {}, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    await wrapper
      .findAll('button')
      .find((b) => b.text() === "Use this device's")!
      .trigger('click');
    const value = (input(wrapper, 'Time zone').element as HTMLInputElement).value;
    expect(value).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('Clear unsets every saved key', async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: { 'display-name': 'X' }, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    const clear = wrapper.findAll('button').find((b) => b.text() === 'Clear')!;
    await clear.trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toEqual({ url: `/api/networks/${NET}/metadata`, method: 'DELETE' });
    expect(useProfileEditor().networkId.value).toBeNull();
  });

  it('opens only on a connected network that carries metadata', () => {
    const editor = useProfileEditor();
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    expect(editor.canOpen(NET)).toBe(true);
    setNetwork({ state: 'connected', metadataLimits: { ...LIMITS, maxKeys: 0 } });
    expect(editor.canOpen(NET)).toBe(false);
    setNetwork({ state: 'connected', metadataLimits: null });
    expect(editor.canOpen(NET)).toBe(false);
    setNetwork({ state: 'disconnected', metadataLimits: LIMITS });
    expect(editor.canOpen(NET)).toBe(false);
  });

  it('greys, keeping what was typed, when the network drops while it is open', async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: {}, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    await input(wrapper, 'Status').setValue('lunch');
    useNetworksStore().states[NET]!.state = 'disconnected';
    await flushPromises();
    expect(input(wrapper, 'Status').attributes('disabled')).toBeDefined();
    expect((input(wrapper, 'Status').element as HTMLInputElement).value).toBe('lunch');
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
  });

  it('uploads an avatar, fills the field with its link, and previews the crop', async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = {
      values: { avatar: 'https://old.example/a.png' },
      unset: [],
      live: {},
      avatarPreview: '/proxied/old',
    };
    const wrapper = await open();
    expect(wrapper.find('img.avatar').attributes('src')).toBe('/proxied/old');

    const picker = wrapper.find('input[type="file"]');
    const file = new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' });
    Object.defineProperty(picker.element, 'files', { value: [file] });
    await picker.trigger('change');
    await flushPromises();

    expect(multipart.at(-1)!.url).toBe('/api/uploads');
    expect(multipart.at(-1)!.fields.purpose).toBe('avatar');
    expect((input(wrapper, 'Avatar URL').element as HTMLInputElement).value).toBe(
      'https://cdn.example/me.webp',
    );
    expect(wrapper.find('img.avatar').attributes('src')).toBe('/api/uploads/5/thumb');

    // A typed link isn't fetched to preview it.
    await input(wrapper, 'Avatar URL').setValue('https://elsewhere.example/b.png');
    expect(wrapper.find('img.avatar').exists()).toBe(false);
  });

  it("copies another network's saved profile into the form", async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: {}, unset: [], live: {}, avatarPreview: null };
    const wrapper = await open();
    // Saved there, or only on that server: both copy.
    reply = {
      values: { pronouns: 'they/them' },
      unset: [],
      live: { status: 'on that server' },
      avatarPreview: null,
    };
    await wrapper.find('select').setValue('8');
    await flushPromises();
    expect(calls.at(-1)!.url).toBe('/api/networks/8/metadata');
    expect((input(wrapper, 'Pronouns').element as HTMLInputElement).value).toBe('they/them');
    expect((input(wrapper, 'Status').element as HTMLInputElement).value).toBe('on that server');
  });

  it('says avatars need lurker-previews, once the server has said it has none', async () => {
    setNetwork({ state: 'connected', metadataLimits: LIMITS });
    reply = { values: {}, unset: [], live: {}, avatarPreview: null };
    const config = useConfigStore();

    // Not yet answered: the flag's default is off, which isn't the server saying so.
    let wrapper = await open();
    expect(wrapper.find('.no-avatars').exists()).toBe(false);
    wrapper.unmount();

    config.checked = true;
    wrapper = await open();
    expect(wrapper.find('.no-avatars').text()).toContain('lurker-previews');
    wrapper.unmount();

    config.features = { ...config.features, linkPreviews: true };
    wrapper = await open();
    expect(wrapper.find('.no-avatars').exists()).toBe(false);
  });
});
