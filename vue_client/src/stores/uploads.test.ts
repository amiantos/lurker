// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Lets a test drive the real upload() action and watch the store react to the
// browser-leg progress events the way an XHR would deliver them.
type MultipartOpts = { onProgress(pct: number): void };
const apiMultipart =
  vi.fn<(url: string, fd: FormData, opts: MultipartOpts) => Promise<Record<string, unknown>>>();
vi.mock('../api.js', () => ({
  api: vi.fn<() => Promise<unknown>>(async () => ({ items: [] })),
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
