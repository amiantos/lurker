// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Does a resolved descriptor actually RENDER? The server side of previews is covered
// thoroughly and was verified live, and QA still saw no YouTube card — so the gap is
// between "the server answered correctly" and "a card appeared", and nothing was testing
// that span.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageAttachment from './MessageAttachment.vue';
import type { LinkPreview } from '../composables/useLinkPreview.js';
import { useSettingsStore } from '../stores/settings.js';

// The component reads its preview through the composable, which normally talks to the
// server. Hoisted mock with a mutable holder: `vi.spyOn` on the module namespace doesn't
// reach the binding the compiled SFC already captured.
// Must be a REAL ref: the template relies on Vue's auto-unwrapping, which is keyed on
// `isRef`, so a plain `{ value }` object renders as undefined and every assertion fails
// for a reason that has nothing to do with the component.
const resolved = ref<LinkPreview | null>(null);
vi.mock('../composables/useLinkPreview.js', () => ({ useLinkPreview: () => resolved }));

const YOUTUBE: LinkPreview = {
  url: 'https://www.youtube.com/watch?v=6yRUqNmcI_M',
  status: 'ok',
  kind: 'video-embed',
  title: 'PAPA NUGS & DJ ADHD - THE VOICES',
  siteName: 'YouTube',
  author: 'Maslow Unknown',
  thumb: '/api/link-preview/media/tok',
  thumbWidth: 480,
  thumbHeight: 360,
  embedUrl: 'https://www.youtube-nocookie.com/embed/6yRUqNmcI_M?autoplay=1&rel=0',
  expiresAt: '2099-01-01T00:00:00Z',
};

const IMAGE: LinkPreview = {
  url: 'https://e.test/a.png',
  status: 'ok',
  kind: 'image',
  src: '/api/link-preview/media/tok2',
  thumbWidth: 800,
  thumbHeight: 600,
  mime: 'image/png',
  expiresAt: '2099-01-01T00:00:00Z',
};

/** Mount with the resolver stubbed, so nothing touches the network. */
function mountWith(preview: LinkPreview, { inlineMedia = true, linkPreviews = true } = {}) {
  resolved.value = preview;
  setActivePinia(createPinia());
  // Real store values, not a mocked getter: `effective` is a Pinia getter returning a
  // closure, so it can't be spied — and seeding state exercises the same lookup the app
  // does, which is the more honest test anyway.
  const settings = useSettingsStore();
  settings.values = {
    'chat.inline_media.enabled': inlineMedia,
    'chat.link_previews.enabled': linkPreviews,
    'chat.image_modal.enabled': true,
  };
  settings.loaded = true;

  return mount(MessageAttachment, { props: { url: preview.url } });
}

describe('MessageAttachment — video embed', () => {
  beforeEach(() => {
    resolved.value = null;
  });

  it('renders a card for a resolved YouTube descriptor', () => {
    const wrapper = mountWith(YOUTUBE);
    expect(wrapper.find('.card').exists()).toBe(true);
    expect(wrapper.text()).toContain('PAPA NUGS');
    expect(wrapper.text()).toContain('YouTube');
  });

  it('shows the play facade, and NOT an iframe, before any click', () => {
    const wrapper = mountWith(YOUTUBE);
    expect(wrapper.find('.card-play').exists()).toBe(true);
    // The privacy property: nothing reaches the video host on render.
    expect(wrapper.find('iframe').exists()).toBe(false);
  });

  it('creates the iframe only once the play button is clicked', async () => {
    const wrapper = mountWith(YOUTUBE);
    await wrapper.find('.card-play').trigger('click');
    const frame = wrapper.find('iframe');
    expect(frame.exists()).toBe(true);
    expect(frame.attributes('src')).toContain('youtube-nocookie.com');
  });

  it('points the thumbnail at our proxy, never at the origin', () => {
    const wrapper = mountWith(YOUTUBE);
    expect(wrapper.find('.card-thumb-wide').attributes('src')).toBe('/api/link-preview/media/tok');
  });

  it('renders nothing when link previews are off', () => {
    const wrapper = mountWith(YOUTUBE, { linkPreviews: false });
    expect(wrapper.find('.card').exists()).toBe(false);
  });

  it('is governed by link previews, not by inline media', async () => {
    // A video PAGE is a page. Someone with inline media on and previews off must not get
    // a YouTube card.
    const wrapper = mountWith(YOUTUBE, { inlineMedia: true, linkPreviews: false });
    expect(wrapper.find('.card').exists()).toBe(false);
  });
});

describe('MessageAttachment — inline image', () => {
  beforeEach(() => {
    resolved.value = null;
  });

  it('renders the image through the proxy with its real dimensions', async () => {
    const wrapper = mountWith(IMAGE);
    const img = wrapper.find('img.inline-image');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('/api/link-preview/media/tok2');
    // Load-bearing: these reserve the box before the bytes arrive.
    expect(img.attributes('width')).toBe('800');
    expect(img.attributes('height')).toBe('600');
  });

  it('renders nothing when inline media is off', () => {
    const wrapper = mountWith(IMAGE, { inlineMedia: false });
    expect(wrapper.find('img.inline-image').exists()).toBe(false);
  });
});
