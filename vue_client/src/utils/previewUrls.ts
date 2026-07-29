// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createUrlRegex } from '../../../shared/urlPattern.js';
import { mediaKindForUrl } from './uploadHostMatch.js';

/**
 * Cap on CARDS per message.
 *
 * Slack allows five, halloy defaults to one. Three is enough for a message genuinely sharing
 * a few links, and short of enough for one message to take over a screen. Each card costs
 * real vertical space, so this one has to stay tight.
 */
export const MAX_CARDS_PER_MESSAGE = 3;

/**
 * Cap on MEDIA per message — deliberately generous.
 *
 * Media doesn't cost vertical space the way a card does: two or more images render as one
 * horizontally-scrolling strip of fixed height, so the tenth image costs exactly as much
 * screen as the second. And clicking any of them opens the lightbox as a GALLERY over the
 * whole strip, so nothing is unreachable.
 *
 * A limit still exists, because a message carrying fifty image URLs is spam and each one is
 * an outbound fetch on the server's behalf. It's set high enough not to bind on anything a
 * person would actually post.
 */
export const MAX_MEDIA_PER_MESSAGE = 20;

/** @deprecated Kept for the old single-cap name; prefer the two above. */
export const MAX_PREVIEWS_PER_MESSAGE = MAX_CARDS_PER_MESSAGE;

export interface PreviewToggles {
  inlineMedia: boolean;
  linkPreviews: boolean;
}

/**
 * Which URLs in a message body are worth asking the server about.
 *
 * The two toggles select different URLs, which is the whole reason they're two
 * settings: inline media covers links that ARE a file, link previews cover links
 * to a page. With both off this returns an empty array without touching the
 * network — that's what makes the features genuinely free when disabled.
 *
 * ⚠ The extension test here is a HINT, not a verdict. It decides which setting
 * would cover a URL and therefore whether to bother asking; the server answers
 * authoritatively from Content-Type, and the render path re-checks that answer
 * against the settings. Guessing wrong costs one wasted resolve, never a render
 * the user switched off.
 */
export function previewableUrls(
  text: string | null | undefined,
  { inlineMedia, linkPreviews }: PreviewToggles,
): string[] {
  if (!inlineMedia && !linkPreviews) return [];
  if (!text) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  let mediaCount = 0;
  let cardCount = 0;

  for (const match of text.matchAll(createUrlRegex())) {
    const raw = match[0];
    // The shared pattern also matches bare `www.` hosts and email addresses.
    // Neither is fetchable as written, and we are emphatically not resolving
    // somebody's email address.
    if (!/^https?:\/\//i.test(raw)) continue;

    // Trailing punctuation belongs to the sentence, not to the URL: "see
    // https://example.com/x." must not resolve a path ending in a full stop.
    // A closing bracket is included for the same reason, at the known cost of
    // clipping the rare URL that legitimately ends in one.
    const url = raw.replace(/[.,;:!?)\]}'"]+$/, '');
    if (!url || seen.has(url)) continue;

    const looksLikeMedia = mediaKindForUrl(url) !== null;
    if (looksLikeMedia ? !inlineMedia : !linkPreviews) continue;
    if (looksLikeMedia ? mediaCount >= MAX_MEDIA_PER_MESSAGE : cardCount >= MAX_CARDS_PER_MESSAGE)
      continue;

    if (looksLikeMedia) mediaCount++;
    else cardCount++;
    seen.add(url);
    out.push(url);
  }
  return out;
}
