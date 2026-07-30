// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { primePreviews, useLinkPreview, resetLinkPreviewCache } from './useLinkPreview.js';
import * as apiModule from '../api.js';

const BOTH = { inlineMedia: true, linkPreviews: true };

let posted: string[][];

beforeEach(() => {
  resetLinkPreviewCache();
  posted = [];
  vi.spyOn(apiModule, 'api').mockImplementation(async (_url, opts) => {
    const urls = ((opts ?? {}).body as { urls: string[] }).urls;
    posted.push(urls);
    return {
      previews: urls.map((url) => ({
        url,
        status: 'ok',
        kind: 'page',
        title: 'T',
        expiresAt: '2099-01-01T00:00:00Z',
      })),
    } as never;
  });
});

afterEach(() => vi.restoreAllMocks());

/** Let the coalescing timer fire and the request settle. */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('rendering has no side effects', () => {
  it('reading a preview NEVER triggers a request', async () => {
    // ⚠⚠ The architectural invariant. The first version resolved as a side effect of
    // rendering, which meant every scroll into history kicked off fetches that grew rows
    // under the reader — and needed the list to keep correcting its own scroll position.
    // A read must be a read.
    const entry = useLinkPreview('https://e.test/page');
    await settle();
    expect(posted).toEqual([]);
    expect(entry.value).toBeNull();
  });

  it('priming is what resolves, and a later read sees the result', async () => {
    primePreviews(['look at https://e.test/page'], BOTH);
    const entry = useLinkPreview('https://e.test/page');
    await settle();
    expect(posted).toEqual([['https://e.test/page']]);
    expect(entry.value?.title).toBe('T');
  });
});

describe('rendering never blocks priming', () => {
  it('a URL that was RENDERED before priming is still primed', async () => {
    // ⚠⚠ Regression guard, and this one shipped broken once: `useLinkPreview` inserts a cache
    // entry as a side effect of being read, and the skip condition was `cache.has(url)` — so a
    // mere render permanently blocked that URL. The failure path was the default one: both
    // settings off → nothing primed → user enables one → rows render and create null entries →
    // no later history page, backlog replay or live message could ever queue them.
    const url = 'https://e.test/rendered-first';
    useLinkPreview(url); // a row renders and reads it
    await settle();
    expect(posted).toEqual([]);

    primePreviews([`look at ${url}`], BOTH);
    await settle();
    expect(posted).toEqual([[url]]);
  });
});

describe('primePreviews', () => {
  it('coalesces a whole batch into one request', async () => {
    // A history page arrives as one batch; it must not become one POST per row.
    primePreviews(['https://e.test/a', 'https://e.test/b', 'https://e.test/c'], BOTH);
    await settle();
    expect(posted.length).toBe(1);
    expect(posted[0]).toHaveLength(3);
  });

  it('asks about a repeated link once across the whole batch', async () => {
    primePreviews(['see https://e.test/x', 'also https://e.test/x'], BOTH);
    await settle();
    expect(posted).toEqual([['https://e.test/x']]);
  });

  it('does not re-ask for something already known', async () => {
    primePreviews(['https://e.test/x'], BOTH);
    await settle();
    posted = [];
    // An overlapping history page, or a re-render, must be free.
    primePreviews(['https://e.test/x'], BOTH);
    await settle();
    expect(posted).toEqual([]);
  });

  it('does nothing at all when both settings are off', async () => {
    primePreviews(['https://e.test/a https://e.test/b.png'], {
      inlineMedia: false,
      linkPreviews: false,
    });
    await settle();
    expect(posted).toEqual([]);
  });

  it('splits a batch past the server cap across requests', async () => {
    primePreviews(
      Array.from({ length: 25 }, (_, i) => `https://e.test/${i}`),
      BOTH,
    );
    await settle();
    expect(posted.length).toBe(2);
    expect(posted[0]).toHaveLength(20);
    expect(posted[1]).toHaveLength(5);
  });

  it('tolerates null and empty bodies', async () => {
    primePreviews([null, undefined, ''], BOTH);
    await settle();
    expect(posted).toEqual([]);
  });
});
