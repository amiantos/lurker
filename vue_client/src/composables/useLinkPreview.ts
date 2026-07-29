// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Client half of link previews: ask the server about a URL, once, ever.
//
// Everything expensive is on the server — the fetch, the parse, the cache, the
// byte proxy. What's left here is the thing a client is uniquely placed to do:
// notice that a screenful of scrollback contains the same eight URLs forty
// times, and turn that into one request.
//
// Two layers of coalescing, because they catch different things:
//
//   - `cache` dedupes across TIME. Scroll down past a link and back up, and the
//     second render is free.
//   - `queue` dedupes across a TICK. A buffer switch mounts fifty rows in one
//     frame; they all want previews, and they become one POST rather than fifty.
//
// Without the second, opening a link-heavy channel would fire a request per row
// and immediately eat the server's per-user rate limit.

import { ref, type Ref } from 'vue';
import { api } from '../api.js';

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
 * Bumped whenever a batch of previews lands and changed something.
 *
 * A message list needs to know that rows just got taller, and it can't learn that from any
 * individual preview ref — the growth is spread across however many rows were in the batch,
 * and it all reflows in one tick. One counter for the whole batch is exactly the granularity
 * the scroll fix wants: react once, after everything settles.
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
      for (const url of slice) {
        const entry = cache.get(url);
        if (entry && entry.value === null) cache.delete(url);
      }
    }
  }
}

/**
 * A reactive preview for `url`, resolving in the background.
 *
 * Starts null and fills in. Callers render nothing until it's populated, so a
 * preview appearing is always an addition to the layout — never a flash of a
 * skeleton that then collapses.
 */
export function useLinkPreview(url: string): Ref<LinkPreview | null> {
  const existing = cache.get(url);
  if (existing) return existing;

  const entry = ref<LinkPreview | null>(null);
  cache.set(url, entry);
  queue.add(url);
  if (flushTimer === null) flushTimer = setTimeout(() => void flush(), FLUSH_MS);
  return entry;
}

/** Test-only: drop everything so a suite starts from a known state. */
export function resetLinkPreviewCache(): void {
  previewRevision.value = 0;
  cache.clear();
  queue = new Set();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
