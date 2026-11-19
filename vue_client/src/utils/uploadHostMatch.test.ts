// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import { isImageUrl, mediaKindForUrl } from './uploadHostMatch.js';

describe('isImageUrl', () => {
  it('matches image URLs on any host', () => {
    expect(isImageUrl('https://example.com/abc.png')).toBe(true);
  });

  it('matches image extensions case-insensitively', () => {
    expect(isImageUrl('https://files.catbox.moe/abc.JPG')).toBe(true);
  });

  it('matches image paths with query strings', () => {
    expect(isImageUrl('https://files.catbox.moe/abc.png?v=2')).toBe(true);
  });

  it('matches image extensions in the middle of the path', () => {
    expect(
      isImageUrl(
        'https://static.wikia.nocookie.net/onepiece/images/6/6d/Luffy.png/revision/latest?cb=20240306200817',
      ),
    ).toBe(true);
  });

  it('matches mid-path extensions case-insensitively', () => {
    expect(isImageUrl('https://example.com/path/foo.JPG/transform/x')).toBe(true);
  });

  it('rejects URLs without image extensions', () => {
    expect(isImageUrl('https://files.catbox.moe/abc.txt')).toBe(false);
  });

  it('does not match extension-like substrings without dot and segment boundaries', () => {
    expect(isImageUrl('https://example.com/png-guide')).toBe(false);
    expect(isImageUrl('https://example.com/image-png/foo')).toBe(false);
    expect(isImageUrl('https://example.com/foo.png-extra/bar')).toBe(false);
  });

  it('matches image URLs on previously unsupported hosts', () => {
    expect(isImageUrl('https://imgur.com/abc.png')).toBe(true);
  });

  it('rejects malformed URLs', () => {
    expect(isImageUrl('not a url')).toBe(false);
  });
});

// #563. The viewer shows four kinds now, and this is the one rule that decides which —
// a link clicked in a message and a tile clicked in the uploads grid both come here, so
// they cannot disagree about what a URL is.
describe('mediaKindForUrl', () => {
  it.each([
    ['https://x.test/a.png', 'image'],
    ['https://x.test/a.webp', 'image'],
    ['https://x.test/a.mp4', 'video'],
    ['https://x.test/a.mov', 'video'],
    ['https://x.test/a.m4v', 'video'],
    ['https://x.test/a.mp3', 'audio'],
    ['https://x.test/a.m4a', 'audio'],
    ['https://x.test/a.txt', 'text'],
    // VIDEO, deliberately, even though the ones we serve are audio-only voice memos:
    // 3gp can carry a picture, and <video> on audio-only content still plays where
    // <audio> on a real clip would silently drop the video. See uploadHostMatch.ts.
    ['https://x.test/a.3gp', 'video'],
    ['https://x.test/a.3g2', 'video'],
  ] as const)('classifies %s as %s', (url, kind) => {
    expect(mediaKindForUrl(url)).toBe(kind);
  });

  // Deliberately WIDER than what the uploader accepts. The viewer renders links; it is
  // not a gate on uploads. These were once refused as uploads (#553) and played as
  // links all the same; the table must not narrow to whatever the uploader takes.
  it.each([
    ['https://x.test/a.webm', 'video'],
    ['https://x.test/a.mkv', 'video'],
    ['https://x.test/a.ogv', 'video'],
    ['https://x.test/a.flac', 'audio'],
    ['https://x.test/a.ogg', 'audio'],
    ['https://x.test/a.opus', 'audio'],
    ['https://x.test/a.wav', 'audio'],
  ] as const)('plays %s, whatever the uploader happens to accept', (url, kind) => {
    expect(mediaKindForUrl(url)).toBe(kind);
  });

  it('is case-insensitive and survives a query string', () => {
    expect(mediaKindForUrl('https://x.test/CLIP.MP4?v=2')).toBe('video');
  });

  // Anything we can't name stays an ordinary link that opens in a new tab — the
  // behaviour every URL had before the viewer existed.
  it.each([
    'https://x.test/page.html',
    'https://x.test/archive.zip',
    'https://x.test/',
    'not-a-url',
  ])('leaves %s unclassified', (url) => {
    expect(mediaKindForUrl(url)).toBeNull();
  });

  // ⚠ Regression guard, NOT an oversight. The uploader mints `.md` and `.json`
  // (#788) and it is tempting to list them here so our own upload opens in-app —
  // but this table judges arbitrary chat links, and those extensions are
  // overwhelmingly PAGE urls. Listing them swallows the click on a GitHub blob and
  // lands the user on "could not read this file" instead of GitHub, and makes
  // previewUrls count the same link as media so it loses its preview card. See the
  // note in uploadHostMatch.ts before changing this.
  it.each([
    'https://github.com/o/r/blob/main/README.md',
    'https://x.test/docs/guide.markdown',
    'https://api.x.test/v1/users.json',
  ])('leaves %s alone rather than swallowing the click', (url) => {
    expect(mediaKindForUrl(url)).toBeNull();
  });

  it('keeps isImageUrl in agreement with itself', () => {
    expect(isImageUrl('https://x.test/a.png')).toBe(true);
    // An image-only caller must not start treating videos as images.
    expect(isImageUrl('https://x.test/a.mp4')).toBe(false);
  });
});
