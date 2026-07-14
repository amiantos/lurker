// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The viewer's mode switch and its load lifecycle (#563).
//
// This file exists because of a bug it would have caught. Removing `autoplay` from the
// <video>/<audio> broke them completely: the load handler was bound to `loadeddata`,
// which only fires once a FRAME has been buffered — something `preload="metadata"`
// deliberately never does. Autoplay had been forcing that load and hiding the mistake.
// Take it away and the event never comes, `loading` never clears, and `v-show` leaves
// the player hidden behind a spinner that spins forever.
//
// No unit test could see that: the bug lived entirely in which DOM event was bound to
// which handler. So the test mounts the real component and fires the real events.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import MediaViewerModal from './MediaViewerModal.vue';

// Text is the one mode that FETCHES (see the CORS block below), so it must never be
// allowed to reach the network from a test.
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function open(url: string) {
  return mount(MediaViewerModal, { props: { url } });
}

describe('MediaViewerModal — mode', () => {
  it('renders an <img> for an image', () => {
    const w = open('https://x.test/a.webp');
    expect(w.find('img.image').exists()).toBe(true);
    expect(w.find('video').exists()).toBe(false);
  });

  it('renders a <video> for a video', () => {
    const w = open('https://x.test/clip.mp4');
    expect(w.find('video.video').exists()).toBe(true);
    expect(w.find('img.image').exists()).toBe(false);
  });

  it('renders an <audio> for audio', () => {
    const w = open('https://x.test/song.mp3');
    expect(w.find('audio.audio').exists()).toBe(true);
  });

  it('renders a <pre> for text', () => {
    const w = open('https://x.test/notes.txt');
    expect(w.find('pre.text').exists()).toBe(true);
  });

  // playsinline is not optional: without it iOS Safari yanks the video into its own
  // native fullscreen player and the viewer — gallery arrows, copy link, all of it —
  // is gone. It is one attribute and it is invisible until you test on a phone.
  it('keeps video inline on iOS', () => {
    const w = open('https://x.test/clip.mp4');
    const video = w.find('video').element as HTMLVideoElement;
    expect(video.hasAttribute('playsinline')).toBe(true);
  });

  // Opening a file to look at it is not asking it to start making noise — and with the
  // gallery arrows, autoplay would fire off a new track on every keypress.
  it.each(['clip.mp4', 'song.mp3'])('does not autoplay %s', (file) => {
    const w = open(`https://x.test/${file}`);
    const el = w.find('video, audio').element as HTMLMediaElement;
    expect(el.autoplay).toBe(false);
  });

  // The zoom control is meaningless on a player and dead on a <pre>. A dead button on
  // three modes out of four is worse than no button.
  it('offers zoom for images only', () => {
    expect(open('https://x.test/a.webp').find('[aria-label="zoom in"]').exists()).toBe(true);
    expect(open('https://x.test/clip.mp4').find('[aria-label="zoom in"]').exists()).toBe(false);
    expect(open('https://x.test/song.mp3').find('[aria-label="zoom in"]').exists()).toBe(false);
  });
});

// ⚠ THE REGRESSION. Each of these fails if the handler is bound to `loadeddata` again.
describe('MediaViewerModal — load lifecycle', () => {
  it('shows a spinner until the media reports in', () => {
    const w = open('https://x.test/clip.mp4');
    expect(w.find('.loading').exists()).toBe(true);
  });

  it.each([
    ['video', 'https://x.test/clip.mp4'],
    ['audio', 'https://x.test/song.mp3'],
  ])('clears the spinner when %s metadata arrives', async (tag, url) => {
    const w = open(url);
    expect(w.find('.loading').exists()).toBe(true);

    // The event a browser ACTUALLY fires under preload="metadata". `loadeddata` would
    // not come until a frame was buffered, which without autoplay never happens.
    await w.find(tag).trigger('loadedmetadata');

    expect(w.find('.loading').exists()).toBe(false);
    expect(w.find('.failed-card').exists()).toBe(false);
  });

  it('clears the spinner when an image loads', async () => {
    const w = open('https://x.test/a.webp');
    await w.find('img').trigger('load');
    expect(w.find('.loading').exists()).toBe(false);
  });

  it.each([
    ['video', 'https://x.test/clip.mp4'],
    ['audio', 'https://x.test/song.mp3'],
    ['img', 'https://x.test/a.webp'],
  ])('falls back to the open-in-browser card when %s fails', async (tag, url) => {
    const w = open(url);
    await w.find(tag).trigger('error');
    expect(w.find('.failed-card').exists()).toBe(true);
  });
});

// Text is the only mode subject to CORS: an <img> or <video> RENDERS a cross-origin
// file without the host's permission, but READING one requires it. So .txt works on the
// `local` driver (same origin) and is at the mercy of the provider anywhere else.
describe('MediaViewerModal — text', () => {
  const ok = (body: string) =>
    ({ ok: true, status: 200, text: async () => body }) as unknown as Response;

  it('shows the file when the host allows the read', async () => {
    fetchMock.mockResolvedValue(ok('the long message someone pasted'));
    const w = open('https://x.test/notes.txt');
    await flushPromises();

    expect(w.find('pre.text').text()).toBe('the long message someone pasted');
    expect(w.find('.loading').exists()).toBe(false);
  });

  // The whole reason this is best-effort rather than a feature we can promise. A
  // refused read must land on the same "open in browser" card a dead image already did
  // — which is exactly the behaviour a .txt link had before the viewer knew about text,
  // so nothing is lost by trying.
  it('falls back to open-in-browser when the host refuses (CORS)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const w = open('https://x.test/notes.txt');
    await flushPromises();

    expect(w.find('.failed-card').exists()).toBe(true);
    expect(w.text()).toContain('the host may not allow it');
  });

  it('falls back on a non-2xx too', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 } as unknown as Response);
    const w = open('https://x.test/notes.txt');
    await flushPromises();
    expect(w.find('.failed-card').exists()).toBe(true);
  });

  // A .txt upload is a pasted chat message, but nothing stops someone linking a 200 MB
  // log, and a <pre> with that in it locks the tab.
  it('truncates a file too big to render', async () => {
    fetchMock.mockResolvedValue(ok('x'.repeat(500_000)));
    const w = open('https://x.test/huge.txt');
    await flushPromises();

    const shown = w.find('pre.text').text();
    expect(shown.length).toBeLessThan(500_000);
    expect(shown).toContain('truncated');
  });

  // The other three kinds hand their URL to an element and never read the bytes.
  it.each(['a.webp', 'clip.mp4', 'song.mp3'])('does not fetch %s', (file) => {
    open(`https://x.test/${file}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
