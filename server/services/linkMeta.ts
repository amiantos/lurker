// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Pulling preview metadata out of an HTML document, and out of an oEmbed reply.
//
// Deliberately NOT a DOM parser. The Lounge pulls in cheerio for this; we need
// four tags out of `<head>` on a document we've already truncated to 256 KB, and
// a focused scanner is a fraction of the code, has no dependency to track CVEs
// on, and can't be induced to build a tree out of something hostile. The cost is
// that we'd miss metadata that only exists after JavaScript runs — but so does
// every other unfurler, Slack and Discord included, so a site that renders og:
// tags client-side simply doesn't get a card anywhere.
//
// Pure and synchronous: bytes in, a plain object out. All the network lives in
// linkFetch.ts, which makes this the easy half to test exhaustively.

/** Raw metadata as found in a document. Any field may be absent. */
export interface ScrapedMeta {
  title?: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  /** og:type — `video.*` and `music.*` are the ones that change our rendering. */
  ogType?: string;
  /** Discovered `<link rel=alternate type=application/json+oembed>` endpoint. */
  oembedUrl?: string;
}

/** The subset of an oEmbed reply we're willing to act on. */
export interface OEmbedMeta {
  type?: string;
  title?: string;
  authorName?: string;
  providerName?: string;
  thumbnailUrl?: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
}

// Metadata lives in <head>. Anything past the start of <body> is page content,
// and scanning it is both wasted work and a way to pick up a stray <meta> from
// inside some third-party embed.
function headRegion(html: string): string {
  const bodyAt = html.search(/<body[\s>]/i);
  return bodyAt === -1 ? html : html.slice(0, bodyAt);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/**
 * Decode the HTML entities that actually turn up in metadata.
 *
 * `og:description` is a string sitting inside an HTML attribute, so it arrives
 * escaped — an undecoded one renders as `Tom &amp; Jerry` in the card. halloy
 * has a whole `description_decode_html` config knob because some sites
 * double-escape; we decode once, unconditionally, which is right for the
 * overwhelming majority and leaves a `&amp;amp;` site looking slightly wrong
 * rather than making everyone else's apostrophes look broken.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // Surrogates and out-of-range values would throw; leave them literal.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Decode bytes to text using the document's declared charset.
 *
 * A surprising amount of the long tail is still windows-1252, and reading it as
 * UTF-8 turns every smart quote into a replacement character right in the title.
 * Node speaks utf8 and latin1 natively; latin1 is close enough to windows-1252
 * for the punctuation that matters here. Anything more exotic falls back to
 * UTF-8, which is the correct guess for essentially everything written this
 * century.
 */
export function decodeBody(body: Buffer, contentTypeHeader: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentTypeHeader)?.[1];
  // Read a prefix as ASCII to find an in-document declaration. Any charset we
  // care about is ASCII-compatible in its first bytes, so this is safe.
  const probe = body.subarray(0, 2048).toString('latin1');
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(probe)?.[1] ||
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(probe)?.[1];

  const charset = (fromHeader || fromMeta || 'utf-8').toLowerCase();
  if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252') {
    return body.toString('latin1');
  }
  return body.toString('utf8');
}

// One <meta>/<link> tag's attributes, order-independent and quote-agnostic.
// Real-world HTML puts these in every order and quotes them three ways.
function attr(tag: string, name: string): string | undefined {
  // ⚠ Anchored on a boundary that a hyphen does NOT satisfy. `\b${name}` matched inside
  // hyphen-prefixed attributes — `-` is a non-word character, so `\bcontent` matches within
  // `data-content` — and since the first match wins,
  // `<meta property="og:title" data-content="Loading…" content="Real Title">` produced the
  // placeholder. Same shape for `name` vs `data-name`, and for `type` vs `data-type` in the
  // oEmbed `<link rel=alternate>` scan, where it could hide an endpoint entirely.
  const m = new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(
    tag,
  );
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}

/**
 * Scan a document's head for preview metadata.
 *
 * Precedence within each field is Open Graph → Twitter Card → plain HTML, which
 * is the order of decreasing intentionality: `og:title` was written to be a
 * preview title, `<title>` was written to be a browser tab. Note this differs
 * from Slack, which takes whichever of OG and Twitter appears *first* in the
 * document; a fixed precedence is easier to reason about and to test, and the
 * two disagree only on pages that set both to different values, which is a
 * mistake on the page's part either way.
 */
export function scrapeMeta(html: string): ScrapedMeta {
  const head = headRegion(html);
  const out: ScrapedMeta = {};

  const og = new Map<string, string>();
  const twitter = new Map<string, string>();

  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const content = attr(tag, 'content');
    if (!content) continue;
    // OG uses `property`, Twitter Card uses `name`, and plenty of sites use the
    // wrong one for both — so read either and route by the key's prefix.
    const key = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    if (!key) continue;
    if (key.startsWith('og:')) {
      if (!og.has(key)) og.set(key, content); // first wins: og:image repeats
    } else if (key.startsWith('twitter:')) {
      if (!twitter.has(key)) twitter.set(key, content);
    } else if (key === 'description' && !twitter.has('description')) {
      twitter.set('description', content);
    }
  }

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];

  out.title = og.get('og:title') || twitter.get('twitter:title') || titleTag;
  out.description =
    og.get('og:description') || twitter.get('twitter:description') || twitter.get('description');
  out.siteName = og.get('og:site_name') || twitter.get('twitter:site');
  out.imageUrl =
    og.get('og:image:secure_url') ||
    og.get('og:image') ||
    twitter.get('twitter:image') ||
    twitter.get('twitter:image:src');
  out.ogType = og.get('og:type');

  for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    const type = (attr(tag, 'type') || '').toLowerCase();
    if (rel.includes('alternate') && type === 'application/json+oembed') {
      out.oembedUrl = attr(tag, 'href');
      break;
    }
    if (!out.imageUrl && rel === 'image_src') out.imageUrl = attr(tag, 'href');
  }

  // Decode and tidy at the boundary, so callers never handle a raw entity.
  for (const k of ['title', 'description', 'siteName'] as const) {
    const v = out[k];
    if (v !== undefined) {
      const clean = decodeEntities(v).replace(/\s+/g, ' ').trim();
      if (clean) out[k] = clean;
      else delete out[k];
    }
  }
  for (const k of ['imageUrl', 'oembedUrl'] as const) {
    const v = out[k];
    if (v !== undefined) out[k] = decodeEntities(v).trim();
  }
  return out;
}

/**
 * Read the fields we trust out of an oEmbed reply.
 *
 * Note what is NOT read: `html`. oEmbed hands back a ready-made iframe, and
 * injecting a third party's markup into the message list is not a thing we are
 * going to do — it's an XSS vector wearing a standards badge. We take the
 * structured fields and build any embed ourselves from a provider table we
 * control (see linkEmbed.ts).
 */
export function readOEmbed(json: unknown): OEmbedMeta | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

  return {
    type: str(o.type),
    title: str(o.title),
    authorName: str(o.author_name),
    providerName: str(o.provider_name),
    thumbnailUrl: str(o.thumbnail_url),
    thumbnailWidth: num(o.thumbnail_width),
    thumbnailHeight: num(o.thumbnail_height),
  };
}
