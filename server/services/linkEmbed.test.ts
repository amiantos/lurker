// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { videoEmbedFor, EMBED_ORIGINS } from './linkEmbed.js';

const embed = (raw: string) => videoEmbedFor(new URL(raw));

describe('videoEmbedFor — YouTube', () => {
  it('recognises every shape people actually paste', () => {
    for (const raw of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
    ]) {
      expect(embed(raw)?.embedUrl).toContain('dQw4w9WgXcQ');
    }
  });

  it('always uses the no-cookie host', () => {
    const e = embed('https://www.youtube.com/watch?v=abc123');
    expect(e?.embedUrl.startsWith('https://www.youtube-nocookie.com/embed/')).toBe(true);
    expect(e?.provider).toBe('YouTube');
  });

  it('carries a start time through', () => {
    expect(embed('https://youtu.be/abc123?t=90')?.embedUrl).toContain('start=90');
    expect(embed('https://www.youtube.com/watch?v=abc123&start=42')?.embedUrl).toContain(
      'start=42',
    );
  });

  it('ignores a nonsense start time rather than passing it on', () => {
    expect(embed('https://youtu.be/abc123?t=notanumber')?.embedUrl).not.toContain('start=');
    expect(embed('https://youtu.be/abc123?t=-5')?.embedUrl).not.toContain('start=');
  });

  it('suppresses end-screen recommendations from other channels', () => {
    expect(embed('https://youtu.be/abc123')?.embedUrl).toContain('rel=0');
  });

  it('refuses an id that is not id-shaped', () => {
    // The id lands in a URL we construct, so anything with structure in it is
    // either a parse mistake or someone probing.
    expect(embed('https://www.youtube.com/watch?v=../../evil')).toBeNull();
    expect(embed('https://www.youtube.com/watch?v=a%2Fb')).toBeNull();
    expect(embed('https://www.youtube.com/watch?v=')).toBeNull();
  });

  it('is not fooled by a lookalike hostname', () => {
    expect(embed('https://youtube.com.evil.test/watch?v=abc123')).toBeNull();
    expect(embed('https://notyoutube.com/watch?v=abc123')).toBeNull();
  });
});

describe('videoEmbedFor — Vimeo', () => {
  it('recognises the usual forms', () => {
    expect(embed('https://vimeo.com/123456789')?.embedUrl).toContain('123456789');
    expect(embed('https://player.vimeo.com/video/123456789')?.embedUrl).toContain('123456789');
  });

  it('asks Vimeo not to track', () => {
    expect(embed('https://vimeo.com/123456789')?.embedUrl).toContain('dnt=1');
  });
});

describe('videoEmbedFor — everything else', () => {
  it('returns null, which is an ordinary outcome', () => {
    // A non-video link still gets a normal card; it just has no play button.
    expect(embed('https://example.com/an-article')).toBeNull();
  });
});

describe('EMBED_ORIGINS', () => {
  it('covers every origin the table can actually emit', () => {
    const emitted = [
      embed('https://youtu.be/abc123')!.embedUrl,
      embed('https://vimeo.com/123')!.embedUrl,
    ];
    for (const url of emitted) {
      expect(EMBED_ORIGINS.some((o) => url.startsWith(o))).toBe(true);
    }
  });
});
