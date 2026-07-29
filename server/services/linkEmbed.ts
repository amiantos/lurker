// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Turning a video page URL into a player URL we're willing to put in an iframe.
//
// ⚠ The embed URL is derived HERE, from a table we maintain — never taken from
// the provider. oEmbed replies carry an `html` field containing a ready-made
// iframe, and dropping a third party's markup into the message list would be an
// XSS vector with a standards document attached. We read the structured fields
// (title, author, thumbnail) and construct the player ourselves, so the only
// origins that can ever end up in a frame are the ones written below.
//
// Everything here is privacy-first by construction:
//
//   - YouTube goes to youtube-nocookie.com, which defers tracking cookies until
//     playback actually starts.
//   - The thumbnail is proxied through us like any other preview image, so not
//     even the *thumbnail* request reaches Google. This matters more than it
//     sounds: a channel with fifty YouTube links in scrollback would otherwise
//     hand Google fifty impressions of you, from your IP, for videos you never
//     watched.
//   - The iframe is not created until the viewer clicks play (the facade
//     pattern, in the clients). Nothing here talks to a provider on render.
//
// So the full sequence for a YouTube link is: our server scrapes the page, our
// server fetches the thumbnail, our server hands the client a card — and the
// first request the *viewer* makes to Google is the one they asked for by
// pressing ▶.

export interface VideoEmbed {
  /** Origin-restricted player URL, safe to put in an iframe on click. */
  embedUrl: string;
  provider: string;
}

/** Extract a YouTube video id from any of the shapes people paste. */
function youtubeId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return id || null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') return url.searchParams.get('v');
    // /embed/ID, /v/ID, /shorts/ID, /live/ID
    const m = /^\/(?:embed|v|shorts|live)\/([^/?#]+)/.exec(url.pathname);
    if (m) return m[1];
  }
  return null;
}

function vimeoId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
  const m = /\/(?:video\/)?(\d+)/.exec(url.pathname);
  return m ? m[1] : null;
}

// Ids reach a URL we build, so they get a strict shape check first. Both
// providers use short alphanumeric-ish tokens; anything else is either a parse
// mistake or someone probing for an injection.
const SAFE_ID = /^[\w-]{1,64}$/;

/**
 * The player URL for a video page, or null if we don't know this provider.
 *
 * Returning null is a normal outcome, not a failure: the link still gets an
 * ordinary preview card with its thumbnail, it just doesn't get a ▶.
 */
export function videoEmbedFor(url: URL): VideoEmbed | null {
  const yt = youtubeId(url);
  if (yt && SAFE_ID.test(yt)) {
    const params = new URLSearchParams({
      // The user clicked play, so start playing; without this the facade costs
      // a second click for no reason.
      autoplay: '1',
      // Don't let the player suggest videos from unrelated channels when it ends.
      rel: '0',
    });
    // Start time, if the link carried one (?t=90 / ?start=90 / youtu.be#t=).
    const t = url.searchParams.get('t') || url.searchParams.get('start');
    const seconds = t ? Number.parseInt(t, 10) : NaN;
    if (Number.isFinite(seconds) && seconds > 0) params.set('start', String(seconds));
    return {
      embedUrl: `https://www.youtube-nocookie.com/embed/${yt}?${params}`,
      provider: 'YouTube',
    };
  }

  const vim = vimeoId(url);
  if (vim && SAFE_ID.test(vim)) {
    return {
      embedUrl: `https://player.vimeo.com/video/${vim}?autoplay=1&dnt=1`,
      provider: 'Vimeo',
    };
  }

  return null;
}

/**
 * A provider's oEmbed endpoint for a URL, when we know it without asking.
 *
 * ⚠ This exists because scraping YouTube does not work, and cannot be made to work by
 * turning a dial. Measured on `youtube.com/watch?v=…`: 256 KB of HTML read, truncated, and
 * `og:title` **not present anywhere in it** — YouTube front-loads a colossal inline config
 * blob and puts its metadata after it. The Lounge hit the same wall and exposed
 * `prefetchMaxSearchSize` as a config knob so admins could raise it past 300 KB.
 *
 * The same request against YouTube's own oEmbed endpoint returns **848 bytes** containing
 * the title, the author, and a thumbnail URL. Raising a byte cap to "fix" this would mean
 * downloading a megabyte of someone's HTML to extract what they will hand over in under a
 * kilobyte if asked properly.
 *
 * So: known providers are asked directly, before any scraping. Discovery via
 * `<link rel=alternate type=application/json+oembed>` still runs for everyone else
 * (see linkMeta), and HTML scraping remains the fallback for both.
 */
export function oembedEndpointFor(url: URL): string | null {
  const yt = youtubeId(url);
  if (yt && SAFE_ID.test(yt)) {
    // The endpoint wants the canonical watch URL, not whatever shape was pasted.
    const canonical = `https://www.youtube.com/watch?v=${yt}`;
    return `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`;
  }
  const vim = vimeoId(url);
  if (vim && SAFE_ID.test(vim)) {
    const canonical = `https://vimeo.com/${vim}`;
    return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(canonical)}`;
  }
  return null;
}

/**
 * Origins a client may load in a preview iframe.
 *
 * Exported so the Vue client's CSP frame-src and this table can't drift apart —
 * a provider added above without the CSP updated would silently render a blank
 * frame, which is the kind of bug that takes an afternoon.
 */
export const EMBED_ORIGINS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'];
