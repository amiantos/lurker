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

const { useUploadsStore, onInsertUrl } = await import('./uploads.js');
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

describe('uploads.upload — account restrictions', () => {
  it('refuses before the wire when the account may not upload', async () => {
    const { useAuthStore } = await import('./auth.js');
    const auth = useAuthStore();
    auth.user = { id: 1, username: 'held', role: 'user' } as NonNullable<typeof auth.user>;
    auth.setRestrictions({ networks: null, uploads: false });
    const store = useUploadsStore();
    await expect(store.upload(new Blob(['x']), 'x.txt')).rejects.toThrow(
      'uploads are not enabled for this account',
    );
    expect(apiMultipart).not.toHaveBeenCalled();
    expect(store.current).toBeNull();
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

  // ⚠ The optimistic filter and the server's WHERE clause are now ONE definition
  // (shared/uploadKinds.ts). They used to be two hand-written copies, and the client's
  // was a mime PREFIX test — so a `.json`, whose mime IANA files under `application/`,
  // was excluded here while the server's clause returned it (#788). The row would fail
  // to appear, then arrive on the next reload, which reads as a bug in the uploader.
  it('inserts a .json under the text filter, matching what a refetch would return', async () => {
    const uploads = useUploadsStore();
    await uploads.setFilters({ query: '', kind: 'text' });

    apiMultipart.mockResolvedValue({
      id: 20,
      url: 'https://x.test/d.json',
      mime: 'application/json',
    });
    await uploads.upload(new Blob(['{}']), 'data.json');
    expect(uploads.recent.map((u) => u.filename)).toEqual(['data.json']);

    apiMultipart.mockResolvedValue({ id: 21, url: 'https://x.test/r.md', mime: 'text/markdown' });
    await uploads.upload(new Blob(['# hi']), 'README.md');
    expect(uploads.recent.map((u) => u.filename)).toEqual(['README.md', 'data.json']);
  });

  // The shared rule must not have widened `text` into "anything non-media".
  it('still excludes a non-text application/ mime from the text filter', async () => {
    const uploads = useUploadsStore();
    await uploads.setFilters({ query: '', kind: 'text' });

    apiMultipart.mockResolvedValue({
      id: 22,
      url: 'https://x.test/d.pdf',
      mime: 'application/pdf',
    });
    await uploads.upload(new Blob(['x']), 'doc.pdf');
    expect(uploads.recent).toEqual([]);
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

// Starred uploads. Two surfaces read this state — the browser's starred filter
// (`recent`) and the composer's attach menu (`menuItems`) — and the store's real
// job is keeping both true after a star without refetching either.
describe('uploads — favourites', () => {
  const row = (id: number, filename: string, favorite = false) => ({
    id,
    url: `https://x.test/${filename}`,
    filename,
    mime: 'image/webp',
    favorite,
  });

  it('stars over PUT and unstars over DELETE', async () => {
    const uploads = useUploadsStore();
    uploads.recent = [row(1, 'gif.webp')];

    api.mockResolvedValueOnce({ ok: true, favorite: true });
    await uploads.setFavorite(1, true);
    expect(api.mock.calls.at(-1)).toEqual(['/api/uploads/1/favorite', { method: 'PUT' }]);
    expect(uploads.recent[0].favorite).toBe(true);

    api.mockResolvedValueOnce({ ok: true, favorite: false });
    await uploads.setFavorite(1, false);
    expect(api.mock.calls.at(-1)).toEqual(['/api/uploads/1/favorite', { method: 'DELETE' }]);
    expect(uploads.recent[0].favorite).toBe(false);
  });

  // The picker must not need a refetch to be right, and "most recently starred
  // first" is the order the server will hand back — so the local insert has to
  // agree with it or the list reshuffles under the user on the next open.
  it('puts a freshly starred upload at the front of the picker list', async () => {
    const uploads = useUploadsStore();
    uploads.menuItems = [row(1, 'old-favorite.webp', true)];
    uploads.recent = [row(2, 'new-favorite.webp')];

    api.mockResolvedValueOnce({ ok: true, favorite: true });
    await uploads.setFavorite(2, true);

    expect(uploads.menuItems.map((u) => u.id)).toEqual([2, 1]);
    expect(uploads.menuItems[0].favorite).toBe(true);
  });

  it('drops an unstarred upload out of the picker list', async () => {
    const uploads = useUploadsStore();
    uploads.menuItems = [row(1, 'a.webp', true), row(2, 'b.webp', true)];

    api.mockResolvedValueOnce({ ok: true, favorite: false });
    await uploads.setFavorite(1, false);

    expect(uploads.menuItems.map((u) => u.id)).toEqual([2]);
  });

  // Unstarring from inside the starred-only view: the row no longer belongs to the
  // list on screen, so leaving it there would show an unstarred tile in a view that
  // says it only shows starred ones.
  it('removes the row from a starred-only view when it is unstarred', async () => {
    const uploads = useUploadsStore();
    await uploads.setFilters({ favoritesOnly: true });
    uploads.recent = [row(1, 'a.webp', true), row(2, 'b.webp', true)];

    api.mockResolvedValueOnce({ ok: true, favorite: false });
    await uploads.setFavorite(1, false);

    expect(uploads.recent.map((u) => u.id)).toEqual([2]);
  });

  // Not optimistic on purpose: a star that only ever existed locally is worse than a
  // beat of latency, because the whole point is that it's there on the next device.
  it('leaves the row alone when the server refuses', async () => {
    const uploads = useUploadsStore();
    uploads.recent = [row(1, 'a.webp')];

    api.mockRejectedValueOnce(new Error('nope'));
    await expect(uploads.setFavorite(1, true)).rejects.toThrow('nope');

    expect(uploads.recent[0].favorite).toBe(false);
    expect(uploads.menuItems).toEqual([]);
  });

  it('deleting an upload also takes it out of the picker', async () => {
    const uploads = useUploadsStore();
    uploads.recent = [row(1, 'a.webp', true)];
    uploads.menuItems = [row(1, 'a.webp', true)];

    api.mockResolvedValueOnce({ ok: true });
    await uploads.remove(1);

    // The bytes are gone; a picker still offering to insert its URL would paste a 404.
    expect(uploads.menuItems).toEqual([]);
    expect(uploads.recent).toEqual([]);
  });

  it('asks for the starred set as one page, with no cursor to follow', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({ items: [row(1, 'a.webp', true)] });
    await uploads.setFilters({ favoritesOnly: true });

    const params = new URL(api.mock.calls.at(-1)![0], 'https://x.test').searchParams;
    expect(params.get('favorites')).toBe('1');
    // The server orders this view by when you starred, which an id cursor cannot
    // page — so the store must not advertise more to load.
    expect(uploads.hasMore).toBe(false);
  });

  // loadRecent forces hasMore=false for this view, so paging it should be
  // unreachable — but if it ever is reached, the page it appends must still be
  // starred rows. Without the flag the back-fill silently mixes unfiltered history
  // into a list that says it only shows stars.
  it('keeps the starred filter if a next page is ever requested', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({ items: [row(7, 'a.webp', true)] });
    await uploads.setFilters({ favoritesOnly: true });

    uploads.hasMore = true; // the invariant this guards against losing
    api.mockResolvedValueOnce({ items: [] });
    await uploads.loadMore();

    expect(new URL(api.mock.calls.at(-1)![0], 'https://x.test').searchParams.get('favorites')).toBe(
      '1',
    );
  });

  it('loads the picker list without disturbing the browser list', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({ items: [row(1, 'browsing.webp')] });
    await uploads.setFilters({ query: 'browsing' });

    api.mockResolvedValueOnce({ items: [row(2, 'starred.webp', true)] });
    await uploads.loadMenu('favorites');

    const params = new URL(api.mock.calls.at(-1)![0], 'https://x.test').searchParams;
    expect(params.get('favorites')).toBe('1');
    expect(params.get('q')).toBeNull(); // the modal's search must not scope the picker
    expect(uploads.menuItems.map((u) => u.id)).toEqual([2]);
    expect(uploads.recent.map((u) => u.id)).toEqual([1]);
  });

  it('leads with starred when there is a starred set', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({ items: [row(1, 'starred.webp', true)] });
    await uploads.openMenu();

    expect(uploads.menuMode).toBe('favorites');
    expect(api).toHaveBeenCalledTimes(1); // no pointless second request
    expect(uploads.menuItems.map((u) => u.id)).toEqual([1]);
  });

  // Starred-by-default is only useful once you have starred something. Landing a
  // new user on an empty tab next to two buttons is a worse panel than just showing
  // them what they have uploaded.
  it('falls back to recent when nothing is starred', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({ items: [] }); // favourites
    api.mockResolvedValueOnce({ items: [row(5, 'anything.webp')] }); // recent
    await uploads.openMenu();

    expect(uploads.menuMode).toBe('recent');
    expect(uploads.menuItems.map((u) => u.id)).toEqual([5]);
    expect(
      new URL(api.mock.calls.at(-1)![0], 'https://x.test').searchParams.get('favorites'),
    ).toBeNull();
  });

  // The fallback must not latch: star your first upload and the next open should
  // lead with it again, not stay stuck on recent because it was empty once.
  it('re-evaluates the fallback on every open', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({ items: [] });
    api.mockResolvedValueOnce({ items: [row(5, 'anything.webp')] });
    await uploads.openMenu();
    expect(uploads.menuMode).toBe('recent');

    // Something got starred in the meantime.
    api.mockResolvedValueOnce({ items: [row(6, 'now-starred.webp', true)] });
    await uploads.openMenu();
    expect(uploads.menuMode).toBe('favorites');
    expect(uploads.menuItems.map((u) => u.id)).toEqual([6]);
  });

  // Two clicks leave two requests in flight, and the SLOWER one can land last. The
  // panel would then show one mode's rows under the other mode's tab. Easy to hit
  // on a phone: open the menu and immediately tap the other mode.
  it('ignores a menu page that a newer mode switch has superseded', async () => {
    const uploads = useUploadsStore();
    let releaseStale: (v: unknown) => void = () => {};
    const stale = new Promise((r) => {
      releaseStale = r;
    });

    api.mockReturnValueOnce(stale.then(() => ({ items: [row(1, 'STALE-recent.webp')] })));
    const first = uploads.loadMenu('recent');

    api.mockResolvedValueOnce({ items: [row(2, 'FRESH-starred.webp', true)] });
    await uploads.selectMenuMode('favorites');

    // Now let the superseded request finish — after the newer one already landed.
    releaseStale(null);
    expect(await first).toBe(false); // it knows it lost

    expect(uploads.menuMode).toBe('favorites');
    expect(uploads.menuItems.map((u) => u.filename)).toEqual(['FRESH-starred.webp']);
    // The stale request must not clear a spinner the live one owns, either.
    expect(uploads.menuLoading).toBe(false);
  });

  // The same race, but through openMenu: its starred fetch comes back empty AFTER
  // the user has already switched to recent. Falling back then would fire a load
  // over a choice they made deliberately.
  it('does not let the open-time fallback override a mode the user just picked', async () => {
    const uploads = useUploadsStore();
    let releaseOpen: (v: unknown) => void = () => {};
    const open = new Promise((r) => {
      releaseOpen = r;
    });

    api.mockReturnValueOnce(open.then(() => ({ items: [] }))); // starred: empty
    const opening = uploads.openMenu();

    api.mockResolvedValueOnce({ items: [row(3, 'user-picked.webp', true)] });
    await uploads.selectMenuMode('favorites');

    releaseOpen(null);
    await opening;

    expect(uploads.menuMode).toBe('favorites');
    expect(uploads.menuItems.map((u) => u.id)).toEqual([3]);
    expect(api).toHaveBeenCalledTimes(2); // no third, fallback request
  });

  // menuMode names what menuItems HOLDS. A switch that fails is not a switch — the
  // tab must not claim 'recent' over the starred thumbnails still on screen, not
  // least because setFavorite branches on menuMode and would then maintain the
  // wrong list.
  it('leaves the mode alone when the switch fails', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({ items: [row(1, 'starred.webp', true)] });
    await uploads.loadMenu('favorites');

    api.mockRejectedValueOnce(new Error('offline'));
    await uploads.selectMenuMode('recent');

    expect(uploads.menuMode).toBe('favorites');
    expect(uploads.menuItems.map((u) => u.id)).toEqual([1]);
    expect(uploads.menuError).toBe('offline');
  });

  // An explicit switch is a choice, not a fallback — it outlives the panel closing,
  // and the next open must not drag the user back to starred.
  it('keeps an explicitly chosen mode across opens', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({ items: [row(9, 'all-of-them.webp')] });
    await uploads.selectMenuMode('recent');

    api.mockResolvedValueOnce({ items: [row(9, 'all-of-them.webp')] });
    await uploads.openMenu();
    expect(uploads.menuMode).toBe('recent');
  });

  // ⚠ The menu's only action is "insert this". A moderated row's bytes are gone, so
  // offering it would paste a URL that 404s — unlike the browser, which shows the
  // tombstone because seeing WHY a file vanished is the point there. The favourites
  // query excludes them server-side; the unfiltered one does not.
  it('never offers a moderated upload in recent mode', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({
      items: [row(1, 'fine.webp'), { ...row(2, 'gone.webp'), removed: true }],
    });
    await uploads.loadMenu('recent');

    expect(uploads.menuItems.map((u) => u.id)).toEqual([1]);
  });

  // In 'recent' the menu is showing everything, where a star is a property of a row
  // rather than the reason it is listed — so starring must update the flag without
  // reordering or removing anything.
  it('does not reshuffle recent mode when a row is starred', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({ items: [row(1, 'a.webp'), row(2, 'b.webp')] });
    await uploads.loadMenu('recent');

    api.mockResolvedValueOnce({ ok: true, favorite: true });
    await uploads.setFavorite(2, true);

    expect(uploads.menuItems.map((u) => u.id)).toEqual([1, 2]);
    expect(uploads.menuItems[1].favorite).toBe(true);
  });

  // A fresh upload is never starred, so it must not flash into a starred-only view
  // and then vanish on the next reload.
  it('keeps a new upload out of a starred-only view', async () => {
    const uploads = useUploadsStore();
    await uploads.setFilters({ favoritesOnly: true });

    apiMultipart.mockResolvedValue({ id: 30, url: 'https://x.test/n.webp', mime: 'image/webp' });
    await uploads.upload(new Blob(['x']), 'brand-new.png');

    expect(uploads.recent).toEqual([]);
  });

  // The thread panel's composer takes the URL itself: a pasted file there must
  // not also land in the channel's draft.
  it('hands the URL to the caller alone with insert: false', async () => {
    const uploads = useUploadsStore();
    const heard = vi.fn<(url: string) => void>();
    const unsub = onInsertUrl(heard);
    apiMultipart.mockResolvedValue({ id: 40, url: 'https://x.test/t.webp', mime: 'image/webp' });
    try {
      const result = await uploads.upload(new Blob(['x']), null, { insert: false });
      expect(result?.url).toBe('https://x.test/t.webp');
      expect(heard).not.toHaveBeenCalled();
      await uploads.upload(new Blob(['x']), null);
      expect(heard).toHaveBeenCalledWith('https://x.test/t.webp');
    } finally {
      unsub();
    }
  });

  // Every "put this in my message" affordance hangs off this. An insert with
  // nobody subscribed is not an error — emitInsert iterates an empty set and
  // returns — so an ungated button is one that silently does nothing. Which is
  // exactly what shipped on mobile: the uploads browser opens from the buffer-list
  // screen, where MessageInput is not mounted.
  it('knows whether a composer is actually listening', () => {
    const uploads = useUploadsStore();
    expect(uploads.canInsert).toBe(false);

    const unsub = onInsertUrl(() => {});
    expect(uploads.canInsert).toBe(true);

    unsub();
    expect(uploads.canInsert).toBe(false);
  });

  it('flags a starred view that came back full, rather than implying it is complete', async () => {
    const uploads = useUploadsStore();
    api.mockResolvedValueOnce({
      items: Array.from({ length: 200 }, (_, i) => row(i + 1, `f${i}.webp`, true)),
    });
    await uploads.setFilters({ favoritesOnly: true });
    expect(uploads.favoritesTruncated).toBe(true);

    api.mockResolvedValueOnce({ items: [row(1, 'only.webp', true)] });
    await uploads.setFilters({ favoritesOnly: true });
    expect(uploads.favoritesTruncated).toBe(false);
  });
});
