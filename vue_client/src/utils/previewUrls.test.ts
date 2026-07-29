// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { previewableUrls, MAX_CARDS_PER_MESSAGE, MAX_MEDIA_PER_MESSAGE } from './previewUrls.js';

const BOTH = { inlineMedia: true, linkPreviews: true };
const NEITHER = { inlineMedia: false, linkPreviews: false };
const MEDIA_ONLY = { inlineMedia: true, linkPreviews: false };
const PAGES_ONLY = { inlineMedia: false, linkPreviews: true };

describe('previewableUrls — the toggles', () => {
  it('asks for nothing at all when both settings are off', () => {
    // The load-bearing property of default-off: no work, not even a request
    // that gets discarded.
    expect(previewableUrls('https://e.test/a.png and https://e.test/page', NEITHER)).toEqual([]);
  });

  it('inline media selects file links and ignores pages', () => {
    expect(previewableUrls('https://e.test/a.png https://e.test/article', MEDIA_ONLY)).toEqual([
      'https://e.test/a.png',
    ]);
  });

  it('link previews selects pages and ignores file links', () => {
    expect(previewableUrls('https://e.test/a.png https://e.test/article', PAGES_ONLY)).toEqual([
      'https://e.test/article',
    ]);
  });

  it('both on selects both', () => {
    expect(previewableUrls('https://e.test/a.png https://e.test/article', BOTH)).toEqual([
      'https://e.test/a.png',
      'https://e.test/article',
    ]);
  });

  it('treats video and audio links as inline media, not as pages', () => {
    expect(previewableUrls('https://e.test/clip.mp4 https://e.test/song.mp3', MEDIA_ONLY)).toEqual([
      'https://e.test/clip.mp4',
      'https://e.test/song.mp3',
    ]);
    expect(previewableUrls('https://e.test/clip.mp4', PAGES_ONLY)).toEqual([]);
  });
});

describe('previewableUrls — what counts as a URL', () => {
  it('ignores bare www hosts, which are not fetchable as written', () => {
    expect(previewableUrls('see www.example.com for more', BOTH)).toEqual([]);
  });

  it('never resolves an email address', () => {
    // The shared URL pattern matches these; resolving one would be both useless
    // and a small privacy insult.
    expect(previewableUrls('mail me at bob@example.com', BOTH)).toEqual([]);
    expect(previewableUrls('mailto:bob@example.com', BOTH)).toEqual([]);
  });

  it('strips trailing sentence punctuation', () => {
    expect(previewableUrls('go to https://e.test/page.', BOTH)).toEqual(['https://e.test/page']);
    expect(previewableUrls('really? https://e.test/x!', BOTH)).toEqual(['https://e.test/x']);
    expect(previewableUrls('(https://e.test/y)', BOTH)).toEqual(['https://e.test/y']);
  });

  it('keeps a path that legitimately contains punctuation', () => {
    expect(previewableUrls('https://e.test/a.b.c/d', BOTH)).toEqual(['https://e.test/a.b.c/d']);
  });

  it('keeps a query string intact', () => {
    expect(previewableUrls('https://e.test/s?q=1&r=2', BOTH)).toEqual(['https://e.test/s?q=1&r=2']);
  });

  it('handles a message that is nothing but a URL', () => {
    expect(previewableUrls('https://e.test/only', BOTH)).toEqual(['https://e.test/only']);
  });

  it('is fine with empty, null, and undefined text', () => {
    expect(previewableUrls('', BOTH)).toEqual([]);
    expect(previewableUrls(null, BOTH)).toEqual([]);
    expect(previewableUrls(undefined, BOTH)).toEqual([]);
  });
});

describe('previewableUrls — limits', () => {
  it('resolves a repeated link only once', () => {
    const text = 'https://e.test/a https://e.test/a https://e.test/a';
    expect(previewableUrls(text, BOTH)).toEqual(['https://e.test/a']);
  });

  it('caps CARDS tightly, because each one costs vertical space', () => {
    const text = Array.from({ length: 12 }, (_, i) => `https://e.test/${i}`).join(' ');
    expect(previewableUrls(text, BOTH).length).toBe(MAX_CARDS_PER_MESSAGE);
  });

  it('lets many images through, because a strip costs the same at 2 or at 12', () => {
    // Media renders as one horizontally-scrolling strip of fixed height and the lightbox
    // opens as a gallery over the whole thing, so the tenth image costs no more screen than
    // the second and none of them is unreachable.
    const text = Array.from({ length: 12 }, (_, i) => `https://e.test/${i}.png`).join(' ');
    expect(previewableUrls(text, BOTH).length).toBe(12);
  });

  it('still bounds media, so a spam message is not fifty outbound fetches', () => {
    const text = Array.from({ length: 40 }, (_, i) => `https://e.test/${i}.png`).join(' ');
    expect(previewableUrls(text, BOTH).length).toBe(MAX_MEDIA_PER_MESSAGE);
  });

  it('counts the two caps independently', () => {
    // Five cards' worth of pages plus five images: the pages are trimmed to three, the
    // images all survive. One class filling up must not consume the other's budget.
    const pages = Array.from({ length: 5 }, (_, i) => `https://e.test/page${i}`);
    const images = Array.from({ length: 5 }, (_, i) => `https://e.test/img${i}.png`);
    const got = previewableUrls([...pages, ...images].join(' '), BOTH);
    expect(got.filter((u) => u.endsWith('.png')).length).toBe(5);
    expect(got.filter((u) => !u.endsWith('.png')).length).toBe(MAX_CARDS_PER_MESSAGE);
  });

  it('counts the cap after deduping, not before', () => {
    // Four mentions of one link plus two others should yield three previews,
    // not one — otherwise a message quoting the same URL twice would silently
    // lose its other links.
    const text = 'https://e.test/a https://e.test/a https://e.test/b https://e.test/c';
    expect(previewableUrls(text, BOTH)).toEqual([
      'https://e.test/a',
      'https://e.test/b',
      'https://e.test/c',
    ]);
  });
});
