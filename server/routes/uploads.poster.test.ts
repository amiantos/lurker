// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Poster thumbnails for video and audio uploads (#778): the decoder's frame,
// stored in the upload's own thumbnail slot after the upload has answered.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import sharp from 'sharp';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { DecoderResolve } from '../services/previewClient.js';
import type { ContentClass } from '../services/uploadProviders/types.js';

const ctx = setupTestDb('routes-uploads-poster');

const stub = {
  driver: 'stub',
  label: 'Stub',
  capabilities: {
    storesRemotely: true,
    supportsDelete: false,
    mintsKeys: false,
    acceptsContentClasses: ['image', 'text', 'media'] as ContentClass[],
  },
  configSchema: [],
  nextResult: null as { url: string } | null,
  async upload(_source: unknown, meta: { filename: string }) {
    return stub.nextResult ?? { url: `https://stub.example/${meta.filename}` };
  },
};
vi.mock('../services/uploadProviders/index.js', () => ({
  driverIds: ['x0', 'catbox', 'hoarder'],
  getDriver: () => stub,
  splitConfigBySchema: (_driver: unknown, values: Record<string, string>) => ({
    config: values,
    secrets: {},
  }),
}));

const fanOutSpy = vi.fn<(userId: number, payload: unknown) => void>();
vi.mock('../services/wsHub.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wsHub.js')>()),
  fanOutToUser: (userId: number, payload: unknown) => fanOutSpy(userId, payload),
}));

// The decoder, scripted: each call takes the next answer, the last one repeats.
const decoder = vi.hoisted(() => ({
  answers: [] as unknown[],
  calls: [] as Array<{ url: string; wantPoster: boolean }>,
}));
vi.mock('../services/previewClient.js', () => ({
  decoderResolve: async (url: string, wantPoster: boolean) => {
    decoder.calls.push({ url, wantPoster });
    const next = decoder.answers.length > 1 ? decoder.answers.shift() : decoder.answers[0];
    return typeof next === 'function' ? await (next as () => unknown)() : next;
  },
}));

// The control plane's reporter, so a test can hold the first report in flight.
const reporter = vi.hoisted(() => ({
  first: null as Promise<boolean> | null,
  rereported: [] as Array<{ id: number; thumbnail_url: string | null }>,
}));
vi.mock('../services/moderationReport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/moderationReport.js')>()),
  reportUploadSoon: () => reporter.first ?? Promise.resolve(false),
  reportRow: async (row: { id: number; thumbnail_url: string | null }) => {
    reporter.rereported.push({ id: row.id, thumbnail_url: row.thumbnail_url });
    return true;
  },
}));

let app: Express;
let agent: LurkerTestAgent;
let user: User;
let jpeg: Buffer;
let png: Buffer;

function box(type: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + payload.length);
  return Buffer.concat([size, Buffer.from(type, 'latin1'), payload]);
}
/** The smallest thing the classifier calls an mp4. */
function mp4(): Buffer {
  const ftyp = box(
    'ftyp',
    Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('mp42')]),
  );
  return Buffer.concat([
    ftyp,
    box('moov', box('mvhd', Buffer.alloc(100))),
    box('mdat', Buffer.alloc(64)),
  ]);
}

const ok = (poster: Buffer | null): DecoderResolve => ({
  status: 'ok',
  meta: {
    kind: 'video',
    title: null,
    description: null,
    siteName: null,
    author: null,
    imageUrl: null,
    imageWidth: null,
    imageHeight: null,
    embedUrl: null,
    mime: 'video/mp4',
  },
  poster: poster ? { jpeg: poster, width: 640, height: 360 } : null,
});

const uploadClip = () =>
  agent.post('/api/uploads').attach('image', mp4(), {
    filename: 'clip.mp4',
    contentType: 'video/mp4',
  });

const listed = async (id: number): Promise<{ thumbnail_url?: string }> => {
  const list = await agent.get('/api/uploads');
  return list.body.items.find((r: { id: number }) => r.id === id);
};

const thumbFrames = (): Array<{ id: number; thumbnail_url: string }> =>
  fanOutSpy.mock.calls
    .map(([, payload]) => payload as { kind: string; id: number; thumbnail_url: string })
    .filter((p) => p.kind === 'upload-thumbnail');

/** Long enough for a background poster that was going to land to have landed. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./uploads.js')).default;
  user = createUser('poster-alice');
  app = createTestApp({ '/api/uploads': router });
  agent = await createAuthedAgent(app, user.id);
  jpeg = await sharp({
    create: { width: 64, height: 36, channels: 3, background: { r: 0, g: 80, b: 160 } },
  })
    .jpeg()
    .toBuffer();
  png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
});

beforeEach(() => {
  process.env.LURKER_PREVIEWS_URL = 'http://previews.test:8080';
  decoder.answers = [ok(jpeg)];
  decoder.calls = [];
  reporter.first = null;
  reporter.rereported = [];
  stub.nextResult = null;
  fanOutSpy.mockClear();
});

afterAll(() => {
  delete process.env.LURKER_PREVIEWS_URL;
  ctx.cleanup();
});

describe('upload posters (#778)', () => {
  it('gives a video the decoder’s frame as its thumbnail, after the upload answers', async () => {
    const res = await uploadClip();
    expect(res.status).toBe(200);
    // The answer didn't wait for it.
    expect(res.body.thumbnail_url).toBeUndefined();

    await vi.waitFor(() => expect(thumbFrames()).toHaveLength(1));
    expect(decoder.calls).toEqual([{ url: res.body.url, wantPoster: true }]);
    const thumbUrl = `/api/uploads/${res.body.id}/thumb`;
    expect(thumbFrames()[0]).toMatchObject({ id: res.body.id, thumbnail_url: thumbUrl });
    expect((await listed(res.body.id)).thumbnail_url).toBe(thumbUrl);

    // Sized and encoded as an image upload's thumbnail is, not the decoder's JPEG.
    const thumb = await agent.get(thumbUrl).buffer(true);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toMatch(/^image\/webp/);
    const meta = await sharp(thumb.body as Buffer).metadata();
    expect([meta.width, meta.height]).toEqual([512, 512]);
  });

  it('follows the user’s image format', async () => {
    const { setUserSetting, deleteUserSetting } = await import('../db/settings.js');
    setUserSetting(user.id, 'uploads.image.format', 'jpeg');
    try {
      const res = await uploadClip();
      await vi.waitFor(() => expect(thumbFrames()).toHaveLength(1));
      const thumb = await agent.get(`/api/uploads/${res.body.id}/thumb`);
      expect(thumb.headers['content-type']).toMatch(/^image\/jpeg/);
    } finally {
      deleteUserSetting(user.id, 'uploads.image.format');
    }
  });

  it('asks nothing of the decoder when the instance has none', async () => {
    delete process.env.LURKER_PREVIEWS_URL;
    const res = await uploadClip();
    expect(res.status).toBe(200);
    await settle();
    expect(decoder.calls).toEqual([]);
    expect((await listed(res.body.id)).thumbnail_url).toBeUndefined();
  });

  it('asks nothing of the decoder for an image or a text file', async () => {
    const img = await agent
      .post('/api/uploads')
      .attach('image', png, { filename: 'a.png', contentType: 'image/png' });
    const txt = await agent
      .post('/api/uploads')
      .attach('image', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    expect([img.status, txt.status]).toEqual([200, 200]);
    await settle();
    expect(decoder.calls).toEqual([]);
  });

  it.each([
    ['refuses the URL (a private address)', { status: 'refused', reason: 'private' }],
    ['finds the file dead', { status: 'dead' }],
    ['is down', { status: 'down' }],
    ['has no frame to give', ok(null)],
    ['answers bytes that are not a JPEG', ok(Buffer.from('<html>not a picture</html>'))],
    ['answers a JPEG that does not decode', ok(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))],
  ])('leaves the row without a thumbnail when the decoder %s', async (_name, answer) => {
    decoder.answers = [answer];
    const res = await uploadClip();
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(decoder.calls).toHaveLength(1));
    await settle();
    expect(thumbFrames()).toEqual([]);
    expect((await listed(res.body.id)).thumbnail_url).toBeUndefined();
  });

  it('stores nothing against an upload deleted while the decoder worked', async () => {
    const { deleteUpload, uploadAwaitsThumbnail } = await import('../db/uploadHistory.js');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    decoder.answers = [() => held.then(() => ok(jpeg))];
    const res = await uploadClip();
    await vi.waitFor(() => expect(decoder.calls).toHaveLength(1));
    expect(uploadAwaitsThumbnail(res.body.id)).toBe(true);
    deleteUpload(user.id, res.body.id);
    release();
    await settle();
    expect(thumbFrames()).toEqual([]);
  });
});

describe('posterForUpload', () => {
  const row = async (): Promise<number> => {
    const { insertUpload } = await import('../db/uploadHistory.js');
    return insertUpload(user.id, {
      provider: 'stub',
      url: 'https://stub.example/clip.mp4',
      mime: 'video/mp4',
      byte_size: 1,
      thumbnail: null,
    });
  };
  const synced = async (id: number): Promise<number> => {
    const db = (await import('../db/index.js')).default;
    return (
      db.prepare('SELECT synced_to_cp FROM upload_history WHERE id = ?').get(id) as {
        synced_to_cp: number;
      }
    ).synced_to_cp;
  };

  it('tries once more after the wait a busy decoder asked for', async () => {
    const { posterForUpload } = await import('../services/uploadPoster.js');
    decoder.answers = [{ status: 'backoff', retryAfterS: 7 }, ok(jpeg)];
    const waits: number[] = [];
    const id = await row();
    const done = await posterForUpload({
      userId: user.id,
      uploadId: id,
      url: 'https://stub.example/clip.mp4',
      format: 'webp',
      storeRemotely: null,
      reported: Promise.resolve(false),
      wait: async (ms) => void waits.push(ms),
    });
    expect(done).toBe(true);
    expect(waits).toEqual([7000]);
    expect(decoder.calls).toHaveLength(2);
  });

  it('gives up on a decoder still busy after the retry', async () => {
    const { posterForUpload } = await import('../services/uploadPoster.js');
    decoder.answers = [{ status: 'backoff', retryAfterS: 600 }];
    const waits: number[] = [];
    const done = await posterForUpload({
      userId: user.id,
      uploadId: await row(),
      url: 'https://stub.example/clip.mp4',
      format: 'webp',
      storeRemotely: null,
      reported: Promise.resolve(false),
      wait: async (ms) => void waits.push(ms),
    });
    expect(done).toBe(false);
    // The wait is bounded whatever the decoder asked for.
    expect(waits).toEqual([30_000]);
    expect(decoder.calls).toHaveLength(2);
  });

  it('stores the thumbnail with an uploader that hosts them, and reports it again', async () => {
    const { posterForUpload } = await import('../services/uploadPoster.js');
    const { markUploadSynced, getThumbnail } = await import('../db/uploadHistory.js');
    const id = await row();
    // The first report is still in flight, and marks the row synced as it lands.
    let land!: () => void;
    const reported = new Promise<boolean>((r) => {
      land = () => {
        markUploadSynced(id);
        r(true);
      };
    });
    const stored: Buffer[] = [];
    const running = posterForUpload({
      userId: user.id,
      uploadId: id,
      url: 'https://stub.example/clip.mp4',
      format: 'webp',
      storeRemotely: async (thumb) => {
        stored.push(thumb);
        return 'https://cdn.test/thumbs/t1.webp';
      },
      reported,
    });
    await vi.waitFor(() => expect(stored).toHaveLength(1));
    await settle();
    // Nothing is written until that first report has settled…
    expect(thumbFrames()).toEqual([]);
    land();
    expect(await running).toBe(true);

    // …so its "synced" mark can't hide the thumbnail from the control plane.
    expect(await synced(id)).toBe(0);
    expect(reporter.rereported).toEqual([{ id, thumbnail_url: 'https://cdn.test/thumbs/t1.webp' }]);
    expect(getThumbnail(user.id, id)?.thumbnail).toBeNull();
    expect((await listed(id)).thumbnail_url).toBe('https://cdn.test/thumbs/t1.webp');
    expect(thumbFrames()[0]).toMatchObject({
      id,
      thumbnail_url: 'https://cdn.test/thumbs/t1.webp',
    });
  });

  it('keeps the thumbnail inline when the uploader fails to store it', async () => {
    const { posterForUpload } = await import('../services/uploadPoster.js');
    const { getThumbnail } = await import('../db/uploadHistory.js');
    const id = await row();
    const done = await posterForUpload({
      userId: user.id,
      uploadId: id,
      url: 'https://stub.example/clip.mp4',
      format: 'webp',
      storeRemotely: async () => {
        throw new Error('thumb store down');
      },
      reported: Promise.resolve(true),
    });
    expect(done).toBe(true);
    expect(getThumbnail(user.id, id)?.thumbnail).toBeInstanceOf(Buffer);
    expect(reporter.rereported).toEqual([]);
  });

  it('never replaces a thumbnail the row already has', async () => {
    const { setUploadThumbnail } = await import('../db/uploadHistory.js');
    const id = await row();
    expect(setUploadThumbnail(id, Buffer.from('first'), null)).toBe(true);
    expect(setUploadThumbnail(id, Buffer.from('second'), null)).toBe(false);
  });

  it('only dials an absolute http(s) URL', async () => {
    const { posterableUrl } = await import('../services/uploadPoster.js');
    expect(posterableUrl('https://files.example/a.mp4')).toBe(true);
    expect(posterableUrl('http://files.example/a.mp4')).toBe(true);
    // A local upload on an instance with no public base.
    expect(posterableUrl('/uploads/a.mp4')).toBe(false);
  });
});
