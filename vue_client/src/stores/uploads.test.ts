// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Lets a test drive the real upload() action and watch the store react to the
// browser-leg progress events the way an XHR would deliver them.
type MultipartOpts = { onProgress(pct: number): void };
const apiMultipart =
  vi.fn<(url: string, fd: FormData, opts: MultipartOpts) => Promise<Record<string, unknown>>>();
const api = vi.fn<(url: string, opts?: unknown) => Promise<any>>();
vi.mock('../api.js', () => ({
  api: (url: string, opts?: unknown) => api(url, opts),
  apiMultipart: (url: string, fd: FormData, opts: MultipartOpts) => apiMultipart(url, fd, opts),
}));

const { useUploadsStore } = await import('./uploads.js');
type UploadCurrent = NonNullable<ReturnType<typeof useUploadsStore>['current']>;

function current(over: Partial<UploadCurrent> = {}): UploadCurrent {
  return {
    token: 'tok-mine',
    phase: 'uploading',
    progress: 0,
    sentPercent: null,
    destination: null,
    filename: 'photo.png',
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  apiMultipart.mockReset();
  api.mockReset();
  api.mockResolvedValue({ items: [] });
});

// TIER 1 — the part that needs no server cooperation, and the reason #545 is a bug
// rather than a missing feature. xhr.upload only measures browser→server; when it
// hits 100% the file has merely ARRIVED, and the slow half (pipeline + provider send)
// hasn't started. The bar used to read "Uploading: 100%" and sit there looking hung.
describe('uploads.upload — browser-leg progress', () => {
  it('stops claiming to upload the moment the browser leg finishes', async () => {
    const uploads = useUploadsStore();
    const seen: Array<{ phase: string; progress: number }> = [];

    apiMultipart.mockImplementation(
      async (_url: string, _fd: FormData, { onProgress }: { onProgress(p: number): void }) => {
        for (const pct of [25, 75, 100]) {
          onProgress(pct);
          seen.push({ phase: uploads.current!.phase, progress: uploads.current!.progress });
        }
        return { id: 1, url: 'https://x.test/a.webp', mime: 'image/webp' };
      },
    );

    await uploads.upload(new Blob(['x']), 'a.png');

    expect(seen).toEqual([
      { phase: 'uploading', progress: 25 },
      { phase: 'uploading', progress: 75 },
      // NOT 'uploading' at 100 — that was the lie.
      { phase: 'processing', progress: 100 },
    ]);
  });

  // Correlation for the server's frames rides the multipart body, and it has to be
  // appended BEFORE the file: multer fills req.body as fields stream past, so a token
  // sitting behind 200 MB of image would not exist yet when the route reads it.
  it('sends a progress token ahead of the file', async () => {
    const uploads = useUploadsStore();
    apiMultipart.mockResolvedValue({ id: 1, url: 'https://x.test/a.webp' });

    await uploads.upload(new Blob(['x']), 'a.png');

    const fd = apiMultipart.mock.calls[0][1] as FormData;
    const keys = [...fd.keys()];
    expect(keys).toEqual(['progressToken', 'image']);
    expect(fd.get('progressToken')).toBeTruthy();
  });
});

describe('uploads.applyProgress', () => {
  it('advances through the phases the browser cannot see', () => {
    const uploads = useUploadsStore();
    uploads.current = current({ phase: 'processing', progress: 100 });

    uploads.applyProgress({
      token: 'tok-mine',
      phase: 'sending',
      percent: 42,
      destination: 'Catbox',
    });

    expect(uploads.current!.phase).toBe('sending');
    expect(uploads.current!.sentPercent).toBe(42);
    expect(uploads.current!.destination).toBe('Catbox');
  });

  // The frames fan out to EVERY socket the user has open. Two tabs (or a phone and a
  // laptop) uploading at once would otherwise drive each other's bars.
  it("ignores another upload's frames", () => {
    const uploads = useUploadsStore();
    uploads.current = current({ phase: 'processing' });

    uploads.applyProgress({
      token: 'tok-other-tab',
      phase: 'sending',
      percent: 90,
      destination: 'Catbox',
    });

    expect(uploads.current!.phase).toBe('processing');
    expect(uploads.current!.sentPercent).toBeNull();
  });

  it('ignores a frame that arrives with no upload in flight', () => {
    const uploads = useUploadsStore();
    uploads.current = null;
    expect(() =>
      uploads.applyProgress({
        token: 'tok-mine',
        phase: 'sending',
        percent: 50,
        destination: 'Catbox',
      }),
    ).not.toThrow();
    expect(uploads.current).toBeNull();
  });

  // A late 'processing' frame landing after 'sending' has begun would rewind a live
  // percentage back to an indeterminate label — a visibly jumping bar.
  it('never rewinds from sending back to processing', () => {
    const uploads = useUploadsStore();
    uploads.current = current({ phase: 'sending', sentPercent: 60, destination: 'Catbox' });

    uploads.applyProgress({
      token: 'tok-mine',
      phase: 'processing',
      percent: null,
      destination: 'Catbox',
    });

    expect(uploads.current!.phase).toBe('sending');
    expect(uploads.current!.sentPercent).toBe(60);
  });

  // `local` renames the temp file — zero copies, so there is no wire to count. The
  // user still learns which leg they are on; they just get no number.
  it('accepts a sending phase with no percentage', () => {
    const uploads = useUploadsStore();
    uploads.current = current({ phase: 'processing' });

    uploads.applyProgress({
      token: 'tok-mine',
      phase: 'sending',
      percent: null,
      destination: 'Local disk',
    });

    expect(uploads.current!.phase).toBe('sending');
    expect(uploads.current!.sentPercent).toBeNull();
    expect(uploads.current!.destination).toBe('Local disk');
  });
});

// #547. The uploads browser's filters are SERVER-side — unlike almost every other
// filter in Lurker — because the client only holds the pages it has scrolled through
// and the whole point is finding one it hasn't. So the store's job is to build the
// right query and, crucially, to not get confused by its own in-flight requests.
describe('uploads — browser filters', () => {
  const row = (id: number, filename: string, mime: string) => ({
    id,
    url: `https://x.test/${filename}`,
    filename,
    mime,
  });

  it('sends the search term and kind as query params', async () => {
    const uploads = useUploadsStore();
    await uploads.setFilters({ query: 'march shot', kind: 'image' });

    const url = api.mock.calls.at(-1)![0];
    const params = new URL(url, 'https://x.test').searchParams;
    expect(params.get('q')).toBe('march shot');
    expect(params.get('kind')).toBe('image');
    expect(params.get('before')).toBeNull(); // a new filter starts a new list
  });

  it('drops the cursor when the filters change', async () => {
    const uploads = useUploadsStore();
    uploads.cursor = 999;
    await uploads.setFilters({ query: 'x' });
    // The old cursor points into the UNFILTERED sequence; paging with it would walk
    // the wrong rows and silently skip matches.
    expect(api.mock.calls.at(-1)![0]).not.toContain('before=');
  });

  it('carries the filters into the next page', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({ items: [row(7, 'a.png', 'image/webp')] });
    await uploads.setFilters({ query: 'a', kind: 'image' });
    uploads.hasMore = true; // one short page would otherwise end pagination

    await uploads.loadMore();
    const params = new URL(api.mock.calls.at(-1)![0], 'https://x.test').searchParams;
    expect(params.get('before')).toBe('7');
    expect(params.get('q')).toBe('a');
    expect(params.get('kind')).toBe('image');
  });

  // The race that makes typed search feel broken: "scree" is sent, then "screenshot",
  // and the slower FIRST response lands last and overwrites the results of the term
  // the user actually finished typing.
  it('ignores a response that a newer filter has superseded', async () => {
    const uploads = useUploadsStore();
    let releaseStale: (v: unknown) => void = () => {};
    const stale = new Promise((r) => {
      releaseStale = r;
    });

    api.mockReturnValueOnce(stale.then(() => ({ items: [row(1, 'STALE.png', 'image/webp')] })));
    const first = uploads.setFilters({ query: 'scree' });

    api.mockResolvedValueOnce({ items: [row(2, 'FRESH.png', 'image/webp')] });
    await uploads.setFilters({ query: 'screenshot' });

    // Now let the superseded request finish — after the newer one already landed.
    releaseStale(null);
    await first;

    expect(uploads.recent.map((u) => u.filename)).toEqual(['FRESH.png']);
    expect(uploads.query).toBe('screenshot');
    // The stale request must not leave the spinner running either.
    expect(uploads.loading).toBe(false);
  });

  // `recent` holds the results of a FILTER now, not the whole history. An optimistic
  // insert that the active filter excludes would sit at the top of the user's search
  // results and then vanish on the next reload — which reads as a bug.
  it('optimistically inserts a new upload only when it matches the filters', async () => {
    const uploads = useUploadsStore();
    await uploads.setFilters({ query: '', kind: 'image' });

    apiMultipart.mockResolvedValue({ id: 9, url: 'https://x.test/n.txt', mime: 'text/plain' });
    await uploads.upload(new Blob(['x']), 'notes.txt');
    expect(uploads.recent).toEqual([]); // a text upload, while filtered to images

    apiMultipart.mockResolvedValue({ id: 10, url: 'https://x.test/s.webp', mime: 'image/webp' });
    await uploads.upload(new Blob(['x']), 'shot.png');
    expect(uploads.recent.map((u) => u.filename)).toEqual(['shot.png']);
  });

  it('respects the search term when optimistically inserting', async () => {
    const uploads = useUploadsStore();
    await uploads.setFilters({ query: 'holiday' });

    apiMultipart.mockResolvedValue({ id: 11, url: 'https://x.test/s.webp', mime: 'image/webp' });
    await uploads.upload(new Blob(['x']), 'work-thing.png');
    expect(uploads.recent).toEqual([]);

    apiMultipart.mockResolvedValue({ id: 12, url: 'https://x.test/h.webp', mime: 'image/webp' });
    await uploads.upload(new Blob(['x']), 'holiday-snap.png');
    expect(uploads.recent.map((u) => u.filename)).toEqual(['holiday-snap.png']);
  });
});
