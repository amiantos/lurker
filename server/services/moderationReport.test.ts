// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Node edition + orchestrator config before importing the module under test.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NODE_SECRET = 'fleet-secret';
process.env.LURKER_ORCHESTRATOR_URL = 'http://orchestrator:8020';
process.env.LURKER_NODE_NAME = 'cell-test';

import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('moderation-report');

type FetchMock = (...args: unknown[]) => Promise<{ ok: boolean }>;

let mod: typeof import('./moderationReport.js');
let insertUpload: typeof import('../db/uploadHistory.js').insertUpload;
let listUnsyncedUploads: typeof import('../db/uploadHistory.js').listUnsyncedUploads;
let userId: number;

function seedUpload(uploadId: string): number {
  return insertUpload(userId, {
    provider: 'hoarder',
    url: `https://cdn.test/${uploadId}.jpg`,
    filename: `${uploadId}.png`,
    mime: 'image/jpeg',
    byte_size: 1000,
    width: 100,
    height: 100,
    thumbnail: null,
    thumbnail_url: `https://cdn.test/thumbs/${uploadId}.jpg`,
  });
}

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  mod = await import('./moderationReport.js');
  ({ insertUpload, listUnsyncedUploads } = await import('../db/uploadHistory.js'));
  userId = createUser('mod-reporter-alice').id;
});

afterAll(() => {
  ctx.cleanup();
  vi.unstubAllGlobals();
  delete process.env.LURKER_EDITION;
});

describe('reportUpload', () => {
  it('posts to /_cp/moderation/uploads with the bearer + cell-stamped body', async () => {
    const fetchMock = vi.fn<FetchMock>().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const ok = await mod.reportUpload({
      cell_upload_id: 42,
      cell_user_id: userId,
      url: 'https://cdn.test/x.jpg',
      thumb_url: 'https://cdn.test/thumbs/x.jpg',
      mime: 'image/jpeg',
      byte_size: 1234,
      width: 800,
      height: 600,
    });
    expect(ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('http://orchestrator:8020/_cp/moderation/uploads');
    expect(opts.headers.Authorization).toBe('Bearer fleet-secret');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ cell: 'cell-test', cell_upload_id: 42, cell_user_id: userId });
  });

  it('returns false (never throws) when the control plane is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn<FetchMock>().mockRejectedValue(new Error('ECONNREFUSED')));
    const ok = await mod.reportUpload({
      cell_upload_id: 43,
      cell_user_id: userId,
      url: 'https://cdn.test/y.jpg',
      thumb_url: null,
      mime: 'image/jpeg',
      byte_size: 1,
      width: null,
      height: null,
    });
    expect(ok).toBe(false);
  });
});

describe('flushUnsyncedUploads', () => {
  it('drains unsynced rows and marks them synced when the CP accepts them', async () => {
    const id1 = seedUpload('flush-a');
    const id2 = seedUpload('flush-b');
    expect(listUnsyncedUploads(500).some((r) => r.id === id1)).toBe(true);

    vi.stubGlobal('fetch', vi.fn<FetchMock>().mockResolvedValue({ ok: true }));
    const synced = await mod.flushUnsyncedUploads();
    expect(synced).toBeGreaterThanOrEqual(2);

    const stillUnsynced = listUnsyncedUploads(500).map((r) => r.id);
    expect(stillUnsynced).not.toContain(id1);
    expect(stillUnsynced).not.toContain(id2);
  });

  it('leaves rows unsynced when the CP is down (retried next tick)', async () => {
    const id = seedUpload('flush-down');
    vi.stubGlobal('fetch', vi.fn<FetchMock>().mockResolvedValue({ ok: false }));
    await mod.flushUnsyncedUploads();
    expect(listUnsyncedUploads(500).some((r) => r.id === id)).toBe(true);
  });
});

describe('reportUploadSoon', () => {
  it('reports inline (fire-and-forget) and marks the row synced on success', async () => {
    const id = seedUpload('soon');
    vi.stubGlobal('fetch', vi.fn<FetchMock>().mockResolvedValue({ ok: true }));
    mod.reportUploadSoon({
      cell_upload_id: id,
      cell_user_id: userId,
      url: 'https://cdn.test/soon.jpg',
      thumb_url: 'https://cdn.test/thumbs/soon.jpg',
      mime: 'image/jpeg',
      byte_size: 1,
      width: null,
      height: null,
    });
    // Fire-and-forget — poll until the inline report has marked the row synced
    // (deterministic; no fixed sleep that could flake on a loaded CI).
    await vi.waitFor(() => {
      expect(listUnsyncedUploads(500).some((r) => r.id === id)).toBe(false);
    });
  });
});

// A row's thumbnail can arrive after its first report (a media poster, #778).
// The control plane takes the last report's thumb_url and deletes only what it
// has indexed, so what it is told, and in what order, decides whether that
// object can ever be removed.
describe('a row that gains a thumbnail after its first report', () => {
  type Sent = { cell_upload_id: number; thumb_url: string | null };
  /** A control plane whose answers the test releases one at a time. */
  function heldFetch(): { sent: Sent[]; answer: (ok?: boolean) => void } {
    const sent: Sent[] = [];
    const waiting: Array<(r: { ok: boolean }) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<(...args: unknown[]) => Promise<{ ok: boolean }>>((_url, init) => {
        sent.push(JSON.parse((init as { body: string }).body) as Sent);
        return new Promise((resolve) => waiting.push(resolve));
      }),
    );
    return { sent, answer: (ok = true) => waiting.shift()!({ ok }) };
  }
  const mediaRow = (): number =>
    insertUpload(userId, {
      provider: 'dropper',
      url: `https://cdn.test/clip-${Math.random()}.mp4`,
      mime: 'video/mp4',
      byte_size: 1,
      thumbnail: null,
    });
  const unsynced = (id: number): boolean => listUnsyncedUploads(500).some((r) => r.id === id);
  const firstReport = (id: number): void =>
    mod.reportUploadSoon({
      cell_upload_id: id,
      cell_user_id: userId,
      url: 'https://cdn.test/clip.mp4',
      thumb_url: null,
      mime: 'video/mp4',
      byte_size: 1,
      width: null,
      height: null,
    });

  it('is not marked synced by the report that was already in flight', async () => {
    const { setUploadThumbnail } = await import('../db/uploadHistory.js');
    const cp = heldFetch();
    const id = mediaRow();
    firstReport(id);
    await vi.waitFor(() => expect(cp.sent).toHaveLength(1));
    setUploadThumbnail(id, null, 'https://cdn.test/thumbs/late.webp');
    cp.answer();
    await new Promise((r) => setTimeout(r, 20));
    // The control plane acknowledged "no thumbnail", which is no longer the row.
    expect(unsynced(id)).toBe(true);
  });

  it('reports the thumbnail after that report has landed, never alongside it', async () => {
    const { setUploadThumbnail } = await import('../db/uploadHistory.js');
    const cp = heldFetch();
    const id = mediaRow();
    firstReport(id);
    await vi.waitFor(() => expect(cp.sent).toHaveLength(1));
    setUploadThumbnail(id, null, 'https://cdn.test/thumbs/late.webp');
    const second = mod.reportRow({ id, user_id: userId });
    await new Promise((r) => setTimeout(r, 20));
    // Held behind the first: two in flight could land in either order.
    expect(cp.sent).toHaveLength(1);

    cp.answer();
    await vi.waitFor(() => expect(cp.sent).toHaveLength(2));
    expect(cp.sent.map((r) => r.thumb_url)).toEqual([null, 'https://cdn.test/thumbs/late.webp']);
    cp.answer();
    expect(await second).toBe(true);
    expect(unsynced(id)).toBe(false);
  });

  it('sends the row as it stands when its turn comes, not as it was when asked', async () => {
    const { setUploadThumbnail } = await import('../db/uploadHistory.js');
    const cp = heldFetch();
    const id = mediaRow();
    firstReport(id);
    await vi.waitFor(() => expect(cp.sent).toHaveLength(1));
    // What the periodic flush does: it read this row before the thumbnail landed.
    const stale = listUnsyncedUploads(500).find((r) => r.id === id)!;
    expect(stale.thumbnail_url).toBeNull();
    const flushed = mod.reportRow(stale);
    setUploadThumbnail(id, null, 'https://cdn.test/thumbs/late.webp');
    cp.answer();
    await vi.waitFor(() => expect(cp.sent).toHaveLength(2));
    expect(cp.sent[1]!.thumb_url).toBe('https://cdn.test/thumbs/late.webp');
    cp.answer();
    expect(await flushed).toBe(true);
    expect(unsynced(id)).toBe(false);
  });

  it('keeps reporting a row after a report that failed', async () => {
    const cp = heldFetch();
    const id = mediaRow();
    const first = mod.reportRow({ id, user_id: userId });
    const second = mod.reportRow({ id, user_id: userId });
    await vi.waitFor(() => expect(cp.sent).toHaveLength(1));
    cp.answer(false);
    await vi.waitFor(() => expect(cp.sent).toHaveLength(2));
    cp.answer();
    expect([await first, await second]).toEqual([false, true]);
    expect(unsynced(id)).toBe(false);
  });

  it('has nothing to report for a row deleted meanwhile', async () => {
    const { deleteUpload } = await import('../db/uploadHistory.js');
    const cp = heldFetch();
    const id = mediaRow();
    deleteUpload(userId, id);
    expect(await mod.reportRow({ id, user_id: userId })).toBe(false);
    expect(cp.sent).toEqual([]);
  });
});
