// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { scrapeMeta, readOEmbed, decodeEntities, decodeBody } from './linkMeta.js';

describe('decodeEntities', () => {
  it('decodes the named entities that show up in titles', () => {
    expect(decodeEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeEntities('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeEntities('it&apos;s')).toBe("it's");
    expect(decodeEntities('a &mdash; b')).toBe('a — b');
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeEntities('caf&#233;')).toBe('café');
    expect(decodeEntities('caf&#xe9;')).toBe('café');
    expect(decodeEntities('&#x1F600;')).toBe('😀');
  });

  it('leaves unknown and malformed references alone rather than mangling them', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
    // A lone surrogate would throw fromCodePoint; it must survive as literal text.
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeEntities('&#999999999;')).toBe('&#999999999;');
  });

  it('does not double-decode', () => {
    // A site that double-escapes gets `&amp;` back, not `&`. Decoding twice
    // would be a mangling risk for everyone else.
    expect(decodeEntities('a &amp;amp; b')).toBe('a &amp; b');
  });
});

describe('scrapeMeta', () => {
  it('prefers Open Graph over Twitter Card over <title>', () => {
    const meta = scrapeMeta(`
      <html><head>
        <title>Tab Title</title>
        <meta name="twitter:title" content="Twitter Title">
        <meta property="og:title" content="OG Title">
      </head><body></body></html>`);
    expect(meta.title).toBe('OG Title');
  });

  it('falls back down the chain when the preferred tag is absent', () => {
    expect(scrapeMeta('<head><title>Only Title</title></head>').title).toBe('Only Title');
    expect(scrapeMeta('<head><meta name="twitter:title" content="Tw"></head>').title).toBe('Tw');
  });

  it('reads attributes in any order and with any quoting', () => {
    const meta = scrapeMeta(`<head>
      <meta content='Single Quoted' property='og:title'>
      <meta property=og:site_name content=Unquoted>
    </head>`);
    expect(meta.title).toBe('Single Quoted');
    expect(meta.siteName).toBe('Unquoted');
  });

  it('takes the first og:image when a page lists several', () => {
    const meta = scrapeMeta(`<head>
      <meta property="og:image" content="https://e.test/first.png">
      <meta property="og:image" content="https://e.test/second.png">
    </head>`);
    expect(meta.imageUrl).toBe('https://e.test/first.png');
  });

  it('prefers og:image:secure_url over og:image', () => {
    const meta = scrapeMeta(`<head>
      <meta property="og:image" content="http://e.test/plain.png">
      <meta property="og:image:secure_url" content="https://e.test/secure.png">
    </head>`);
    expect(meta.imageUrl).toBe('https://e.test/secure.png');
  });

  it('ignores meta tags that live in the body', () => {
    // A stray <meta> inside a third-party embed must not win over the head.
    const meta = scrapeMeta(`
      <head><meta property="og:title" content="Real"></head>
      <body><meta property="og:title" content="Injected"></body>`);
    expect(meta.title).toBe('Real');
  });

  it('discovers an oEmbed endpoint', () => {
    const meta = scrapeMeta(`<head>
      <link rel="alternate" type="application/json+oembed" href="https://e.test/oembed?url=x">
    </head>`);
    expect(meta.oembedUrl).toBe('https://e.test/oembed?url=x');
  });

  it('ignores the XML oEmbed variant, which we do not parse', () => {
    const meta = scrapeMeta(`<head>
      <link rel="alternate" type="text/xml+oembed" href="https://e.test/oembed.xml">
    </head>`);
    expect(meta.oembedUrl).toBeUndefined();
  });

  it('decodes entities and collapses whitespace in text fields', () => {
    const meta = scrapeMeta(
      `<head><meta property="og:description" content="Tom &amp; Jerry\n   go   west"></head>`,
    );
    expect(meta.description).toBe('Tom & Jerry go west');
  });

  it('drops fields that decode to nothing', () => {
    const meta = scrapeMeta(`<head><meta property="og:title" content="   "></head>`);
    expect(meta.title).toBeUndefined();
  });

  it('returns an empty result for a document with no metadata', () => {
    const meta = scrapeMeta('<html><body><p>hello</p></body></html>');
    expect(meta.title).toBeUndefined();
    expect(meta.imageUrl).toBeUndefined();
  });
});

describe('decodeBody', () => {
  it('honours a charset from the Content-Type header', () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // café
    expect(decodeBody(latin1, 'text/html; charset=iso-8859-1')).toBe('café');
  });

  it('honours a charset declared in the document', () => {
    const body = Buffer.concat([
      Buffer.from('<meta charset="windows-1252">', 'latin1'),
      Buffer.from([0xe9]),
    ]);
    expect(decodeBody(body, 'text/html')).toContain('é');
  });

  it('defaults to UTF-8', () => {
    expect(decodeBody(Buffer.from('café', 'utf8'), 'text/html')).toBe('café');
  });

  it('lets the header win over the document declaration', () => {
    const body = Buffer.from('<meta charset="utf-8">', 'latin1');
    expect(decodeBody(body, 'text/html; charset=iso-8859-1')).toContain('meta charset');
  });
});

describe('readOEmbed', () => {
  it('reads the structured fields', () => {
    const meta = readOEmbed({
      type: 'video',
      title: 'A Video',
      author_name: 'Someone',
      provider_name: 'YouTube',
      thumbnail_url: 'https://i.test/t.jpg',
      thumbnail_width: 480,
      thumbnail_height: 360,
    });
    expect(meta).toMatchObject({
      type: 'video',
      title: 'A Video',
      authorName: 'Someone',
      providerName: 'YouTube',
      thumbnailUrl: 'https://i.test/t.jpg',
      thumbnailWidth: 480,
      thumbnailHeight: 360,
    });
  });

  it('never surfaces the provider html field', () => {
    // The whole point: oEmbed hands back a ready-made iframe and we refuse it.
    const meta = readOEmbed({ type: 'video', html: '<iframe src="https://evil.test"></iframe>' });
    expect(JSON.stringify(meta)).not.toContain('iframe');
  });

  it('rejects non-object input', () => {
    expect(readOEmbed(null)).toBeNull();
    expect(readOEmbed('a string')).toBeNull();
  });

  it('ignores fields of the wrong type or nonsensical value', () => {
    const meta = readOEmbed({ title: 42, thumbnail_width: -1, author_name: '   ' });
    expect(meta?.title).toBeUndefined();
    expect(meta?.thumbnailWidth).toBeUndefined();
    expect(meta?.authorName).toBeUndefined();
  });
});
