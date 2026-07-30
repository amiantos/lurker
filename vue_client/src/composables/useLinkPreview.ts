// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Client half of link previews.
//
// ⚠⚠ Resolution is driven by message INGEST, never by rendering. `primePreviews` is called
// when messages enter the store — a backlog frame, a history page, a live message — and
// components only ever READ, through `useLinkPreview`.
//
// The first version had this backwards: a row asked for its preview *while rendering*, which
// kicked off a fetch, which mutated shared state, which grew the row, which forced the list to
// correct its own scroll position. Rendering had side effects, so every scroll into history
// triggered async growth and needed bespoke compensation. QA felt it exactly as described:
// "the chat loads in completely flat, then inline content loads in a burst, throwing off the
// scroll offset".
//
// Slack and Discord don't have this problem because an unfurl is part of the message record —
// it arrives WITH the message, so scrollback is laid out correctly on first paint and async
// growth only happens for a brand-new message at the bottom, where the list already follows.
// Priming at ingest is how we get that property without the server storing unfurls on every
// message (which would mean fetching for people who have the feature off).
//
// Two layers of coalescing, catching different things:
//
//   - `cache` dedupes across TIME. Scroll past a link and back, and the second pass is free.
//   - `queue` dedupes across a TICK. A history page arrives with fifty rows; they become one
//     POST rather than fifty.

import { ref, type Ref } from 'vue';
import { api } from '../api.js';
import { previewableUrls, type PreviewToggles } from '../utils/previewUrls.js';

export type PreviewKind = 'image' | 'video' | 'audio' | 'page' | 'video-embed';

export interface LinkPreview {
  url: string;
  status: 'ok' | 'unavailable';
  kind: PreviewKind;
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
  /** Proxied bytes for direct media. Server-minted — never built here. */
  src?: string;
  /** Proxied card thumbnail. Server-minted — never built here. */
  thumb?: string;
  thumbWidth?: number;
  thumbHeight?: number;
  embedUrl?: string;
  mime?: string;
  expiresAt: string;
}

// Module-level, not per-component: two message rows showing the same link must
// share one entry, and a row that unmounts on scroll must not throw away what
// it learned.
const cache = new Map<string, Ref<LinkPreview | null>>();

/**
 * URLs priming has already asked about.
 *
 * ⚠ Tracked SEPARATELY from `cache`, and that separation is load-bearing. `useLinkPreview`
 * creates an empty entry as a side effect of being read, so when the skip condition was
 * `cache.has(url)` a mere RENDER blocked that URL from ever being primed. The failure was
 * exactly the default path: with both settings off nothing primes, then the user switches one
 * on, every visible URL gets a null entry from the render pass, and no later history page or
 * live message could ever queue them because they "already existed". Previews stayed missing
 * until a full reload.
 */
const asked = new Set<string>();

/**
 * Bumped when a batch of previews lands and something changed.
 *
 * Only for the residual case: a reader scrolling fast enough to outrun the priming request,
 * so a row renders before its preview is known and grows when it arrives. With priming at
 * ingest this is the exception rather than — as it was — every single scroll into history.
 */
export const previewRevision = ref(0);

let queue = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Server cap per request; batching past it just means a second POST. */
const MAX_BATCH = 20;
/**
 * One frame-ish. Long enough that everything mounting in the same tick lands in
 * one batch, short enough that a preview never feels like it's lagging behind
 * the scroll.
 */
const FLUSH_MS = 24;

async function flush(): Promise<void> {
  flushTimer = null;
  const urls = [...queue];
  queue = new Set();
  if (urls.length === 0) return;

  for (let i = 0; i < urls.length; i += MAX_BATCH) {
    const slice = urls.slice(i, i + MAX_BATCH);
    try {
      const res = await api<{ previews: LinkPreview[] }>('/api/link-preview/resolve', {
        method: 'POST',
        body: { urls: slice },
      });
      let changed = false;
      for (const preview of res.previews ?? []) {
        const entry = cache.get(preview.url);
        // Only an `ok` preview renders anything, so only an `ok` preview can change a row's
        // height — bumping the revision for a batch of `unavailable` answers would make the
        // list re-pin for no reason.
        if (entry) {
          entry.value = preview;
          if (preview.status === 'ok') changed = true;
        }
      }
      if (changed) previewRevision.value++;
    } catch {
      // A failed resolve leaves the ref null, which renders as "no preview" —
      // the same as a link the server couldn't unfurl. There is nothing useful
      // to tell the user about a decoration that didn't appear, and an error
      // state in the message list would be worse than the missing card.
      // Dropped from `asked` as well as `cache`, so a request that failed for transport
      // reasons can be retried on the next priming pass rather than being remembered as a
      // permanent verdict about the URL.
      for (const url of slice) {
        const entry = cache.get(url);
        if (entry && entry.value === null) {
          cache.delete(url);
          asked.delete(url);
        }
      }
    }
  }
}

/**
 * Ceiling on remembered URLs.
 *
 * A long-lived tab would otherwise accumulate an entry per distinct URL for as long as it's
 * open. Evicts oldest-first: `Map` preserves insertion order, and the oldest entry is the one
 * least likely to still be on screen.
 */
const MAX_CACHE_ENTRIES = 2000;

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    asked.delete(oldest);
  }
}

/** Drop entries whose server-side TTL has lapsed, so they can be asked about again.
 *  `expiresAt` was being carried on the wire and never read. */
function dropIfExpired(url: string): void {
  const entry = cache.get(url);
  const expiresAt = entry?.value?.expiresAt;
  if (!expiresAt) return;
  if (Date.parse(expiresAt) > Date.now()) return;
  cache.delete(url);
  asked.delete(url);
}

function entryFor(url: string): Ref<LinkPreview | null> {
  let entry = cache.get(url);
  if (!entry) {
    entry = ref<LinkPreview | null>(null);
    cache.set(url, entry);
  }
  return entry;
}

/**
 * Ask the server about every previewable URL in a batch of message bodies.
 *
 * Called at INGEST — from the socket layer, as messages enter the store — so that by the time
 * a row is rendered its preview is usually already known and the row is laid out correctly on
 * its first paint. Idempotent and cheap: a URL already known or already queued is skipped, so
 * calling this for an overlapping page costs a map lookup per URL.
 *
 * Returns immediately. Nothing awaits it: a history page must not wait on the internet before
 * it can be read.
 */
export function primePreviews(
  texts: readonly (string | null | undefined)[],
  toggles: PreviewToggles,
): void {
  if (!toggles.inlineMedia && !toggles.linkPreviews) return;
  let queued = false;
  for (const text of texts) {
    for (const url of previewableUrls(text, toggles)) {
      dropIfExpired(url);
      if (asked.has(url)) continue;
      asked.add(url);
      entryFor(url);
      queue.add(url);
      queued = true;
    }
  }
  if (queued && flushTimer === null) flushTimer = setTimeout(() => void flush(), FLUSH_MS);
  evictIfNeeded();
}

/**
 * The preview for `url`, if one is known.
 *
 * READ-ONLY: this never triggers a fetch. A component asking about a URL nobody primed gets a
 * permanently-null ref and renders nothing — which is correct, and is the property that keeps
 * rendering free of side effects.
 */
export function useLinkPreview(url: string): Ref<LinkPreview | null> {
  return entryFor(url);
}

/** Test-only: drop everything so a suite starts from a known state. */
export function resetLinkPreviewCache(): void {
  previewRevision.value = 0;
  cache.clear();
  asked.clear();
  queue = new Set();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
