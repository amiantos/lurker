// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import OnboardingFlow from './OnboardingFlow.vue';
import { useSettingsStore } from '../stores/settings.js';
import { useAvatarSetsStore } from '../stores/avatarSets.js';
import { useViewport } from '../composables/useViewport.js';
import { resetOnboarding, useOnboarding } from '../composables/useOnboarding.js';

// The first-run flow's first step: how chat should look. What a new account's
// answer writes, and what it gets when it never answers.

let wrapper: VueWrapper | null = null;
type PatchMany = (changes: Record<string, unknown>) => Promise<void>;
let patchMany: ReturnType<typeof vi.fn<PatchMany>>;
// Requests the flow tried to make. None: see the last test.
let fetched = 0;

function mountFlow(isMobile: boolean, values: Record<string, unknown> = {}) {
  useViewport().isMobile.value = isMobile;
  const settings = useSettingsStore();
  settings.values = values as never;
  patchMany = vi.fn<PatchMany>(async () => {});
  settings.patchMany = patchMany as never;
  // Every bundled tile set, as if its manifest had loaded: the avatar card
  // draws real tiles, and nothing here may reach for the network.
  useAvatarSetsStore().builtinManifests = {
    '/avatars/ealain': { count: 32, ext: 'webp' },
    '/avatars/plain-light': { count: 1, ext: 'webp' },
    '/avatars/plain-dark': { count: 1, ext: 'webp' },
  };
  wrapper = mount(OnboardingFlow, {
    attachTo: document.body,
    global: { stubs: { NetworkPicker: { template: '<div class="network-picker-stub" />' } } },
  });
}

const cards = () => wrapper!.findAll('[role="radio"]');
const checked = () => cards().find((c) => c.attributes('aria-checked') === 'true')!;
const continueButton = () => wrapper!.find('.modal-footer .btn-primary');

describe('OnboardingFlow — the look step', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetOnboarding();
    vi.stubGlobal('fetch', () => {
      fetched++;
      return Promise.reject(new Error('no network in this test'));
    });
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    useViewport().isMobile.value = false;
    vi.unstubAllGlobals();
  });

  it('opens on the look, Traditional first and picked, on a desktop', () => {
    mountFlow(false);
    expect(cards().map((c) => c.find('.name').text())).toEqual([
      'Traditional',
      'Modern',
      'Modern with avatars',
    ]);
    expect(checked().find('.name').text()).toBe('Traditional');
    expect(wrapper!.find('.network-picker-stub').exists()).toBe(false);
    expect(patchMany).not.toHaveBeenCalled();
  });

  it("shows each look's times in that layout's own format", () => {
    mountFlow(false);
    const times = (i: number) =>
      cards()
        [i].findAll('.time')
        .map((t) => t.text());
    // The registry defaults: the grid to the second, the modern head to the minute.
    expect(times(0)).toEqual(['12:01:07', '12:01:31', '12:02:43']);
    expect(times(1)).toEqual(['12:01', '12:02']);
    expect(times(2)).toEqual(['12:01', '12:02']);
    wrapper!.unmount();
    mountFlow(false, {
      'look.buffer.time_format': 'hh:mm a',
      'look.buffer.time_format_modern': '',
    });
    expect(times(0)[0]).toBe('12:01 pm');
    expect(times(1)).toEqual(['', '']);
  });

  it('writes nothing until Continue, then the pick, then moves to the networks', async () => {
    mountFlow(false);
    await cards()[1].trigger('click');
    expect(checked().find('.name').text()).toBe('Modern');
    expect(patchMany).not.toHaveBeenCalled();
    await continueButton().trigger('click');
    await flushPromises();
    expect(patchMany).toHaveBeenCalledTimes(1);
    expect(patchMany).toHaveBeenCalledWith({
      'look.message.layout': 'modern',
      'look.message.avatars': false,
    });
    expect(wrapper!.find('.network-picker-stub').exists()).toBe(true);
    expect(cards()).toHaveLength(0);
  });

  it('turns avatars on with an untouched Traditional: the phone is modern', async () => {
    mountFlow(false);
    await continueButton().trigger('click');
    await flushPromises();
    expect(patchMany).toHaveBeenCalledWith({
      'look.message.layout': 'traditional',
      'look.message.avatars': true,
    });
  });

  it('offers a phone avatars on or off, on first, and never writes the layout', async () => {
    mountFlow(true);
    expect(cards().map((c) => c.find('.name').text())).toEqual(['With avatars', 'Without avatars']);
    expect(checked().find('.name').text()).toBe('With avatars');
    await cards()[1].trigger('click');
    await continueButton().trigger('click');
    await flushPromises();
    expect(patchMany).toHaveBeenCalledWith({ 'look.message.avatars': false });
  });

  it('falls back to what a phone offers when the screen narrows under a Traditional pick', async () => {
    mountFlow(false);
    await cards()[0].trigger('click');
    useViewport().isMobile.value = true;
    await flushPromises();
    expect(checked().find('.name').text()).toBe('With avatars');
    await continueButton().trigger('click');
    await flushPromises();
    expect(patchMany).toHaveBeenCalledWith({ 'look.message.avatars': true });
  });

  it('moves on to the networks even when the look did not save', async () => {
    mountFlow(false);
    patchMany.mockRejectedValueOnce(new Error('offline'));
    await continueButton().trigger('click');
    await flushPromises();
    expect(wrapper!.find('.network-picker-stub').exists()).toBe(true);
  });

  it('comes back at the networks when remounted after the look was answered', async () => {
    mountFlow(false);
    await continueButton().trigger('click');
    await flushPromises();
    wrapper!.unmount();
    mountFlow(true);
    expect(cards()).toHaveLength(0);
    expect(wrapper!.find('.network-picker-stub').exists()).toBe(true);
  });

  it('turns avatars on when setup is skipped before the look was answered', async () => {
    mountFlow(false);
    await wrapper!.find('.skip').trigger('click');
    await flushPromises();
    expect(patchMany).toHaveBeenCalledWith({ 'look.message.avatars': true });
  });

  it('leaves the answer alone when setup is skipped after it', async () => {
    mountFlow(false);
    await cards()[1].trigger('click');
    await continueButton().trigger('click');
    await flushPromises();
    patchMany.mockClear();
    await wrapper!.find('.skip').trigger('click');
    await flushPromises();
    const layoutWrites = patchMany.mock.calls.filter(
      ([changes]) => 'look.message.avatars' in changes || 'look.message.layout' in changes,
    );
    expect(layoutWrites).toEqual([]);
    expect(useOnboarding().isOpen.value).toBe(false);
  });

  // The avatar card draws real tiles; with the manifests in place none of the
  // mounts above should have asked a server for anything.
  it('never reached for the network', () => {
    expect(fetched).toBe(0);
  });
});
