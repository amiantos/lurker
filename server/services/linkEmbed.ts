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

/**
 * A Vimeo video id, and the privacy hash for an unlisted one.
 *
 * ⚠⚠ Anchored with `^`, as `youtubeId` always was. Unanchored, `/\/(?:video\/)?(\d+)/` took
 * digits from ANY path segment, so ordinary Vimeo pages became an embed of an unrelated video:
 * `vimeo.com/blog/post/10-tips-for-video` yielded id `10` and rendered video #10's title,
 * author and thumbnail with a ▶ over it — a wrong answer presented as a right one, and cached
 * under the blog post's key. `vimeo.com/album/12345/video/67890` gave the album id, and
 * `/channels/staffpicks/page/2` gave the page number.
 *
 * ⚠ The `h` parameter is an unlisted video's access token. Dropping it produced an embed URL
 * the player refuses, so the facade's ▶ opened a broken frame — worse than showing no button.
 * It arrives two ways: `vimeo.com/ID/HASH` and `vimeo.com/ID?h=HASH`.
 */
function vimeoId(url: URL): { id: string; hash?: string } | null {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
  const m = /^\/(?:video\/)?(\d+)(?:\/([0-9a-z]+))?\/?$/i.exec(url.pathname);
  if (!m) return null;
  const hash = m[2] || url.searchParams.get('h') || undefined;
  return { id: m[1], hash: hash && /^[0-9a-z]{1,32}$/i.test(hash) ? hash : undefined };
}

/**
 * Seconds from a YouTube timestamp.
 *
 * ⚠ `Number.parseInt` PREFIX-parses, so YouTube's own `1h2m3s` syntax — which its share dialog
 * emits for any timestamp past a minute — silently became `start=1`. A link shared at 1:30
 * started the player one second in, with no signal that anything was wrong; strictly worse than
 * the `?t=notanumber` case, where the guard correctly emitted nothing.
 *
 * Also bounded. `?t=999999999999999999999` passed `Number.isFinite` and `> 0`, and
 * `String(1e21)` is `'1e+21'`, so the URL carried `start=1e%2B21` to a third-party origin
 * immediately after the module had validated the video id against `SAFE_ID`.
 */
const MAX_START_SECONDS = 24 * 60 * 60;

function startSeconds(raw: string | null): number | null {
  if (!raw) return null;
  let total: number;
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    total = Number(hms[1] || 0) * 3600 + Number(hms[2] || 0) * 60 + Number(hms[3] || 0);
  } else if (/^\d+$/.test(raw)) {
    total = Number(raw);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_START_SECONDS) return null;
  return total;
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
    // Start time, if the link carried one: `?t=90`, `?t=1m30s`, `?start=90`.
    //
    // ⚠ A `youtu.be#t=` fragment is NOT reachable and never was — `normalizeUrl` strips the
    // fragment upstream, deliberately, so `#a` and `#b` share one cache entry, and
    // `searchParams` never sees one. The old comment here advertised it as supported, which is
    // the class-I defect this project has a rule about: a comment claiming a behaviour is a
    // testable assertion, and this one was false.
    const seconds = startSeconds(url.searchParams.get('t') || url.searchParams.get('start'));
    if (seconds !== null) params.set('start', String(seconds));
    return {
      embedUrl: `https://www.youtube-nocookie.com/embed/${yt}?${params}`,
      provider: 'YouTube',
    };
  }

  const vim = vimeoId(url);
  if (vim && SAFE_ID.test(vim.id)) {
    const params = new URLSearchParams({ autoplay: '1', dnt: '1' });
    if (vim.hash) params.set('h', vim.hash);
    return {
      embedUrl: `https://player.vimeo.com/video/${vim.id}?${params}`,
      provider: 'Vimeo',
    };
  }

  return null;
}

/**
 * A provider's oEmbed endpoint for a URL, when we know it without asking.
 *
 * ⚠ This exists because scraping YouTube does not work, and cannot be made to work by
 * turning a dial. Measured on `youtube.com/watch?v=…` against a 256 KB cap (what
 * `MAX_SCRAPE_BYTES` was at the time; it is 512 KB now, and the finding is the same): the read
 * was truncated with `og:title` **not present anywhere in it** — YouTube front-loads a colossal
 * inline config blob and puts its metadata after it. The Lounge hit the same wall and exposed
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
  if (vim && SAFE_ID.test(vim.id)) {
    // The hash goes to the endpoint too, or an unlisted video answers 404.
    const canonical = vim.hash
      ? `https://vimeo.com/${vim.id}/${vim.hash}`
      : `https://vimeo.com/${vim.id}`;
    return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(canonical)}`;
  }
  return null;
}

/**
 * Origins a client may load in a preview iframe.
 *
 * ⚠⚠ The comment that used to sit here said this existed "so the Vue client's CSP frame-src
 * and this table can't drift apart." **There is no CSP frame-src anywhere in this repo** — the
 * only Content-Security-Policy headers in the tree are the per-response `default-src 'none'; …
 * sandbox` policies on served bytes (`routes/localUploads.ts`, `dcc.ts`, `avatarSets.ts`,
 * `linkPreview.ts`), each a download or media policy, none a document's. This exact false
 * claim is item 30 of `LINK_PREVIEWS_BUG_INVENTORY.md`, found and
 * written down once already, and it came back verbatim when the file was carried across
 * untouched. A comment asserting a guarantee is a testable assertion; this one would have led
 * whoever adds Twitch to believe the CSP had them covered.
 *
 * What is actually true: this is the allowlist, and `isEmbeddableOrigin` is how a client must
 * check `embedUrl` before framing it. Adding a provider above means adding its origin here —
 * and when a real CSP does land, generating `frame-src` from this array is the way to keep
 * that promise honest.
 */
export const EMBED_ORIGINS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'];

/**
 * Whether a URL may be framed — a real origin comparison, not a prefix test.
 *
 * ⚠ `url.startsWith(origin)` is unsound as an allowlist and it was the idiom the test used:
 * `'https://player.vimeo.com.evil.test/x'.startsWith('https://player.vimeo.com')` is `true`.
 * Nothing shipping consumed `EMBED_ORIGINS` at all, so the unsound check lived only in a test
 * that verified the constant against its own module — which is why this exists as a function
 * clients can call rather than an array they each re-implement a check against.
 */
export function isEmbeddableOrigin(embedUrl: string): boolean {
  try {
    return EMBED_ORIGINS.includes(new URL(embedUrl).origin);
  } catch {
    return false;
  }
}
