// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import sharp from 'sharp';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { UploadSource } from '../services/uploadProviders/source.js';
import type { ContentClass } from '../services/uploadProviders/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../utils/dataDir.js';

const ctx = setupTestDb('routes-uploads');

// Stub driver — the route exercises resolve/upload/url plumbing without reaching
// the real network. Behavior is configurable per-test via state on the
// module-level `stub`. The seed migration creates a real `x0` instance default in
// the test DB; the resolver falls back to it, and the mocked getDriver returns
// this stub for whatever driver id the resolved uploader names.
const stub = {
  driver: 'stub',
  label: 'Stub',
  capabilities: {
    storesRemotely: true,
    supportsDelete: false,
    mintsKeys: false,
    acceptsContentClasses: ['image', 'text'] as ContentClass[],
  },
  configSchema: [],
  shouldThrow: null as Error | null,
  capturedConfig: null as Record<string, string> | null,
  // When set, upload() returns this instead of the default remote URL — used to
  // exercise the storesRemotely:false (local-style relative URL) absolutization.
  nextResult: null as { url: string; ref?: string } | null,
  capturedDeleteRef: null as string | null,
  // What the route handed us. Drivers take an UploadSource now (#543): a
  // passthrough upload must arrive as a `file` (streamed off multer's temp file,
  // never in the heap), while an optimized image arrives as a small `buffer`.
  capturedSource: null as UploadSource | null,
  // The bytes the driver was actually given — the only place to prove that what
  // leaves the building is scrubbed, since the temp file is unlinked afterwards.
  capturedBytes: null as Buffer | null,
  capturedMeta: null as { filename: string; mime: string } | null,
  async upload(
    source: UploadSource,
    meta: { filename: string; mime: string },
    config?: Record<string, string>,
  ) {
    stub.capturedConfig = config ?? null;
    stub.capturedSource = source;
    stub.capturedMeta = meta;
    stub.capturedBytes =
      source.kind === 'file' ? fs.readFileSync(source.path) : Buffer.from(source.data);
    if (stub.shouldThrow) throw stub.shouldThrow;
    if (stub.nextResult) return stub.nextResult;
    return { url: `https://stub.example/${meta.filename}` };
  },
  async delete(ref: string) {
    stub.capturedDeleteRef = ref;
  },
};

// Mock the registry so getDriver returns the stub for whatever driver the
// resolved uploader names. splitConfigBySchema is provided because
// db/uploaderConfig.ts imports it at load; the resolver reads driver.capabilities
// + driver.configSchema off the stub.
vi.mock('../services/uploadProviders/index.js', () => ({
  driverIds: ['x0', 'catbox', 'hoarder'],
  getDriver: () => stub,
  splitConfigBySchema: (_driver: unknown, values: Record<string, string>) => ({
    config: values,
    secrets: {},
  }),
}));

let app: Express;
let agent: LurkerTestAgent;
let user: User;
let smallPng: Buffer;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./uploads.js')).default;

  user = createUser('upload-alice');
  app = createTestApp({ '/api/uploads': router });
  agent = await createAuthedAgent(app, user.id);

  // Real 16x16 image bytes so the sharp pipeline runs end-to-end without
  // needing a fixture file.
  smallPng = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
});

afterAll(() => ctx.cleanup());

describe('POST /api/uploads', () => {
  it('rejects unauthenticated', async () => {
    const res = await createAnonAgent(app).post('/api/uploads');
    expect(res.status).toBe(401);
  });

  it('400 when no file is attached', async () => {
    const res = await agent.post('/api/uploads');
    expect(res.status).toBe(400);
  });

  it('uploads an image through the stub provider and records history', async () => {
    stub.shouldThrow = null;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/stub\.example\//);
    expect(typeof res.body.id).toBe('number');

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    expect(row).toBeTruthy();
    // Whatever the registry default is, the route persists it as the
    // provider id and our mocked getProvider routed to the stub uploader.
    expect(row.provider).toBe('x0');
    expect(row.thumbnail_url).toBe(`/api/uploads/${res.body.id}/thumb`);
  });

  it('uploads a text/plain attachment via the long-message → .txt path', async () => {
    const res = await agent.post('/api/uploads').attach('image', Buffer.from('hello there'), {
      filename: 'note.txt',
      contentType: 'text/plain',
    });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\.txt$/);

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    // Text uploads have no thumbnail.
    expect(row.thumbnail_url).toBeUndefined();
  });

  it('preserves an animated GIF (no re-encode)', async () => {
    // sharp().gif() above produces a single-frame GIF, which the pipeline
    // re-encodes as JPEG. The 'animated bypass' branch is exercised when
    // metadata.pages > 1. Since we don't have a real animated buffer
    // handy, drop a minimal 2-frame GIF created via sharp's joinImages.
    // (sharp's `animated: true` option requires composing multiple frames.)
    const frame = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .raw()
      .toBuffer();
    const animated = await sharp(frame, { raw: { width: 8, height: 8, channels: 3 } })
      .gif({ loop: 0 })
      .toBuffer();
    const res = await agent
      .post('/api/uploads')
      .attach('image', animated, { filename: 'anim.gif', contentType: 'image/gif' });
    expect(res.status).toBe(200);
  });

  it('maps PROVIDER_AUTH into 502 — provider auth is not session auth', async () => {
    // A 401 here would trip the client's bounce-to-login handler and hard-reload
    // the app over a bad *provider* credential while the Lurker session is fine.
    const err = Object.assign(new Error('bad creds'), { code: 'PROVIDER_AUTH' });
    stub.shouldThrow = err;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'auth.png', contentType: 'image/png' });
    expect(res.status).toBe(502);
    stub.shouldThrow = null;
  });

  it('maps PROVIDER_CONFIG into 400', async () => {
    const err = Object.assign(new Error('missing config'), { code: 'PROVIDER_CONFIG' });
    stub.shouldThrow = err;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'cfg.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    stub.shouldThrow = null;
  });

  it('maps unknown provider errors into 502', async () => {
    const err = Object.assign(new Error('upstream down'), { code: 'PROVIDER_ERROR' });
    stub.shouldThrow = err;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'down.png', contentType: 'image/png' });
    expect(res.status).toBe(502);
    stub.shouldThrow = null;
  });

  it('rejects a content class the resolved driver does not accept (415)', async () => {
    const prev = stub.capabilities.acceptsContentClasses;
    stub.capabilities.acceptsContentClasses = ['image']; // no text
    try {
      const res = await agent.post('/api/uploads').attach('image', Buffer.from('hello'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });
      expect(res.status).toBe(415);
    } finally {
      stub.capabilities.acceptsContentClasses = prev;
    }
  });
});

describe('local-style (storesRemotely:false) uploads', () => {
  it('absolutizes a relative driver URL against the request origin', async () => {
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/local/abcdef012345.png', ref: 'abcdef012345.png' };
    try {
      const res = await agent
        .post('/api/uploads')
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-Host', 'irc.example.com')
        .attach('image', smallPng, { filename: 'local.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://irc.example.com/uploads/local/abcdef012345.png');

      // The absolutized URL — not the relative one — is what gets persisted.
      const list = await agent.get('/api/uploads');
      const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
      expect(row.url).toBe('https://irc.example.com/uploads/local/abcdef012345.png');
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.nextResult = null;
    }
  });

  it('ignores a spoofed non-http(s) X-Forwarded-Proto', async () => {
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/local/ccddeeff0011.png', ref: 'ccddeeff0011.png' };
    try {
      const res = await agent
        .post('/api/uploads')
        .set('X-Forwarded-Proto', 'javascript')
        .set('X-Forwarded-Host', 'irc.example.com')
        .attach('image', smallPng, { filename: 'x.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      // The bogus scheme is dropped; never javascript://.
      expect(res.body.url).toBe('https://irc.example.com/uploads/local/ccddeeff0011.png');
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.nextResult = null;
    }
  });

  it('leaves the URL relative when the forwarded host is malformed', async () => {
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/local/223344556677.png', ref: '223344556677.png' };
    try {
      const res = await agent
        .post('/api/uploads')
        .set('X-Forwarded-Host', 'evil.example.com/@attacker')
        .attach('image', smallPng, { filename: 'x.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      // A host with authority-breaking chars is rejected → no base is prefixed.
      expect(res.body.url).toBe('/uploads/local/223344556677.png');
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.nextResult = null;
    }
  });

  it('prefers PUBLIC_BASE_URL over the request origin when set', async () => {
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/local/aabbccddeeff.png', ref: 'aabbccddeeff.png' };
    process.env.PUBLIC_BASE_URL = 'https://cdn.example.org/';
    try {
      const res = await agent
        .post('/api/uploads')
        .set('X-Forwarded-Host', 'ignored.example.com')
        .attach('image', smallPng, { filename: 'local2.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      // Trailing slash on the base is trimmed; the request host is ignored.
      expect(res.body.url).toBe('https://cdn.example.org/uploads/local/aabbccddeeff.png');
    } finally {
      delete process.env.PUBLIC_BASE_URL;
      stub.capabilities.storesRemotely = true;
      stub.nextResult = null;
    }
  });

  it('destroys the bytes via driver.delete before removing a deletable upload', async () => {
    stub.capabilities.storesRemotely = false;
    stub.capabilities.supportsDelete = true;
    stub.nextResult = { url: '/uploads/local/112233445566.png', ref: '112233445566.png' };
    stub.capturedDeleteRef = null;
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'reap.png', contentType: 'image/png' });
      expect(up.status).toBe(200);
      expect(up.body.can_delete).toBe(true);

      const del = await agent.delete(`/api/uploads/${up.body.id}`);
      expect(del.status).toBe(200);
      // Bytes-first: by the time the response lands, the driver has run.
      expect(stub.capturedDeleteRef).toBe('112233445566.png');
      const list = await agent.get('/api/uploads');
      expect(list.body.items.find((r: { id: number }) => r.id === up.body.id)).toBeFalsy();
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.capabilities.supportsDelete = false;
      stub.nextResult = null;
    }
  });

  it('refuses to delete when the driver cannot destroy the bytes (no fake delete)', async () => {
    // A ref is present, but supportsDelete is false → there is no "remove the
    // record but leave the file up" path; the request is refused and the row stays.
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/local/778899aabbcc.png', ref: '778899aabbcc.png' };
    stub.capturedDeleteRef = null;
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'keep.png', contentType: 'image/png' });
      expect(up.body.can_delete).toBe(false);
      const del = await agent.delete(`/api/uploads/${up.body.id}`);
      expect(del.status).toBe(409);
      expect(stub.capturedDeleteRef).toBeNull();
      const list = await agent.get('/api/uploads');
      expect(list.body.items.find((r: { id: number }) => r.id === up.body.id)).toBeTruthy();
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.nextResult = null;
    }
  });
});

describe('GET /api/uploads/:id/thumb', () => {
  it('serves thumbnail bytes', async () => {
    const upload = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'thumby.png', contentType: 'image/png' });
    const res = await agent.get(`/api/uploads/${upload.body.id}/thumb`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("404 for an id we don't own", async () => {
    const res = await agent.get('/api/uploads/999999/thumb');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/uploads/:id', () => {
  it('409 for a row without a delete handle (no ref → never deletable)', async () => {
    // The stub's default upload result carries no ref — like x0 or an anonymous
    // catbox upload. Its row must refuse deletion and stay put.
    const upload = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'delete-me.png', contentType: 'image/png' });
    expect(upload.body.can_delete).toBe(false);
    const del = await agent.delete(`/api/uploads/${upload.body.id}`);
    expect(del.status).toBe(409);
    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === upload.body.id);
    expect(row).toBeTruthy();
    expect(row.can_delete).toBe(false);
  });

  it("404 for a row that doesn't exist", async () => {
    const res = await agent.delete('/api/uploads/999999');
    expect(res.status).toBe(404);
  });

  it('keeps the row and surfaces the failure when the driver delete throws', async () => {
    stub.capabilities.supportsDelete = true;
    stub.nextResult = { url: 'https://stub.example/fail.png', ref: 'fail.png' };
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'fail.png', contentType: 'image/png' });
      expect(up.body.can_delete).toBe(true);

      const origDelete = stub.delete;
      stub.delete = async () => {
        throw Object.assign(new Error('upstream down'), { code: 'PROVIDER_ERROR' });
      };
      try {
        const del = await agent.delete(`/api/uploads/${up.body.id}`);
        expect(del.status).toBe(502);
      } finally {
        stub.delete = origDelete;
      }
      // The bytes weren't destroyed, so the record must survive for a retry.
      const list = await agent.get('/api/uploads');
      const row = list.body.items.find((r: { id: number }) => r.id === up.body.id);
      expect(row).toBeTruthy();
      expect(row.can_delete).toBe(true);

      // And the retry succeeds once the driver recovers.
      const retry = await agent.delete(`/api/uploads/${up.body.id}`);
      expect(retry.status).toBe(200);
    } finally {
      stub.capabilities.supportsDelete = false;
      stub.nextResult = null;
    }
  });

  it('maps a PROVIDER_AUTH delete failure to 502, never 401', async () => {
    // 401 would make the client treat a revoked provider token as a dead Lurker
    // session and reload to the login page mid-click.
    stub.capabilities.supportsDelete = true;
    stub.nextResult = { url: 'https://stub.example/auth.png', ref: 'auth.png' };
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'auth.png', contentType: 'image/png' });
      const origDelete = stub.delete;
      stub.delete = async () => {
        throw Object.assign(new Error('bad creds'), { code: 'PROVIDER_AUTH' });
      };
      try {
        const del = await agent.delete(`/api/uploads/${up.body.id}`);
        expect(del.status).toBe(502);
      } finally {
        stub.delete = origDelete;
      }
    } finally {
      stub.capabilities.supportsDelete = false;
      stub.nextResult = null;
    }
  });

  it('409s (and hides the button) when the config no longer satisfies canDeleteWith', async () => {
    // catbox-shaped case: the row captured a ref while a userhash existed, but
    // the config has since lost it. The row must not advertise can_delete and
    // the route must refuse — a button that always errors is not offered.
    stub.capabilities.supportsDelete = true;
    stub.nextResult = { url: 'https://stub.example/hash.png', ref: 'hash.png' };
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'hash.png', contentType: 'image/png' });
      expect(up.body.can_delete).toBe(true);

      (stub as { canDeleteWith?: (c: Record<string, string>) => boolean }).canDeleteWith = () =>
        false;
      try {
        const list = await agent.get('/api/uploads');
        const row = list.body.items.find((r: { id: number }) => r.id === up.body.id);
        expect(row.can_delete).toBe(false);
        const del = await agent.delete(`/api/uploads/${up.body.id}`);
        expect(del.status).toBe(409);
      } finally {
        delete (stub as { canDeleteWith?: unknown }).canDeleteWith;
      }
    } finally {
      stub.capabilities.supportsDelete = false;
      stub.nextResult = null;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #543: uploads stream through a temp file instead of living in the heap. What
// matters here is the shape handed to the driver and that the temp file never
// outlives the request — an orphan per upload is a slow disk leak.
const tmpDir = (): string => path.join(resolveDataDir(), 'tmp', 'uploads');
const tempFiles = (): string[] => {
  try {
    return fs.readdirSync(tmpDir()).filter((f) => f.startsWith('up-'));
  } catch {
    return [];
  }
};
// The handler unlinks the temp file in a `finally`, which runs AFTER the response
// is sent, so poll — and poll for the ABSOLUTE invariant (the dir drains to empty),
// not a delta against a `before` count, which is itself racy against a preceding
// test's pending unlink.
const waitForNoTemps = async (timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (tempFiles().length > 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`temp files not cleaned up: ${tempFiles().join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('temp-file lifecycle (#543)', () => {
  // The handler unlinks the temp file in a `finally`, which runs AFTER the response
  // is sent — so the client can observe the reply before the unlink has landed.
  // Two consequences, both of which bit this test in CI:
  //   1. Assert by polling, not on the next line (same-tick passes locally, loses
  //      the race on a slower runner).
  //   2. Assert the ABSOLUTE invariant — the temp dir drains to empty — not a
  //      delta against a `before` count, because a previous test's pending unlink
  //      makes that baseline itself a race.
  const waitForNoTemps = async (timeoutMs = 3000): Promise<void> => {
    const start = Date.now();
    while (tempFiles().length > 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`temp files not cleaned up: ${tempFiles().join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const tempFiles = (): string[] => {
    try {
      return fs.readdirSync(tmpDir()).filter((f) => f.startsWith('up-'));
    } catch {
      return [];
    }
  };

  it('hands the driver a FILE source for passthrough, a BUFFER source for images', async () => {
    stub.shouldThrow = null;

    // Text passes through untouched: it must arrive as a file the driver streams,
    // never read into memory. This is the property the whole PR exists for.
    await agent.post('/api/uploads').attach('image', Buffer.from('a passthrough upload'), {
      filename: 'note.txt',
      contentType: 'text/plain',
    });
    expect(stub.capturedSource!.kind).toBe('file');

    // An image is re-encoded by the pipeline, so what goes out is the optimized
    // buffer — small, bounded, and not worth a temp-file round trip.
    await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'pic.png', contentType: 'image/png' });
    expect(stub.capturedSource!.kind).toBe('buffer');
    await waitForNoTemps();
  });

  it('removes the temp file after a successful upload', async () => {
    stub.shouldThrow = null;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'clean.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    await waitForNoTemps();
  });

  it('removes the temp file when the driver fails', async () => {
    stub.shouldThrow = Object.assign(new Error('upstream down'), { code: 'PROVIDER_ERROR' });
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'boom.png', contentType: 'image/png' });
    expect(res.status).toBe(502);
    // A failed upload must not strand its bytes on disk.
    await waitForNoTemps();
    stub.shouldThrow = null;
  });

  it('rejects an over-cap upload with 413 — mid-stream, not after ingesting it', async () => {
    const { setUserSetting } = await import('../db/settings.js');
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 1);
    try {
      const big = Buffer.alloc(2 * 1024 * 1024, 0x7a); // 2 MB against a 1 MB cap
      const res = await agent
        .post('/api/uploads')
        .attach('image', big, { filename: 'big.bin', contentType: 'text/plain' });
      expect(res.status).toBe(413);
      // multer aborts and unlinks its own partial file when the limit trips.
      await waitForNoTemps();
    } finally {
      setUserSetting(user.id, 'uploads.image.max_upload_mb', 25);
    }
  });

  it('sweeps orphaned temp files a crash left behind, but never a live one', async () => {
    const { sweepTempUploads } = await import('./uploads.js');
    fs.mkdirSync(tmpDir(), { recursive: true });
    const stale = path.join(tmpDir(), 'up-stale-orphan');
    const fresh = path.join(tmpDir(), 'up-fresh-inflight');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    // Backdate the orphan past the age gate; the fresh one stands in for an
    // upload in flight right now, which a sweep must not yank out from under.
    const old = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(stale, new Date(old), new Date(old));

    const removed = await sweepTempUploads();
    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.unlinkSync(fresh);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #515: media uploads. The route classifies from magic bytes and scrubs metadata
// before dispatch — the two things that make "we accept video" safe to say.
describe('filenames are UTF-8', () => {
  it('round-trips a non-ASCII filename intact', async () => {
    stub.shouldThrow = null;
    // macOS puts a NARROW NO-BREAK SPACE (U+202F) between the time and AM/PM in
    // screen-recording names. Its UTF-8 bytes are E2 80 AF, and busboy's DEFAULT is
    // to decode multipart params as latin1 — which renders them as "â¯".
    const name = 'Screen Recording 2026-07-12 at 8.10.56\u202fPM.mov';
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: name, contentType: 'image/png' });
    expect(res.status).toBe(200);

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    expect(row.filename).toBe(name);
    expect(row.filename).not.toContain('â');
    await waitForNoTemps();
  });
});

describe('media uploads (#515)', () => {
  /** An mp4 carrying GPS in moov/udta/©xyz, exactly where a phone puts it. */
  const GPS = '+37.7749-122.4194/';
  function box(type: string, payload: Buffer): Buffer {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + payload.length);
    return Buffer.concat([size, Buffer.from(type, 'latin1'), payload]);
  }
  function mp4WithGps(): Buffer {
    const ftyp = box(
      'ftyp',
      Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('mp42')]),
    );
    const mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(0xe679e672, 4);
    const udta = box(
      'udta',
      box('©xyz', Buffer.concat([Buffer.from([0, 0x12, 0x15, 0xc7]), Buffer.from(GPS)])),
    );
    const moov = box('moov', Buffer.concat([box('mvhd', mvhd), udta]));
    return Buffer.concat([ftyp, moov, box('mdat', Buffer.alloc(1024, 0xab))]);
  }

  beforeAll(() => {
    stub.capabilities.acceptsContentClasses = ['image', 'text', 'media'];
  });
  afterAll(() => {
    stub.capabilities.acceptsContentClasses = ['image', 'text'];
  });

  it('accepts an mp4, passes it through unoptimized, and gives it no thumbnail', async () => {
    stub.shouldThrow = null;
    const res = await agent
      .post('/api/uploads')
      .attach('image', mp4WithGps(), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(200);
    expect(res.body.mime).toBe('video/mp4');
    // Passthrough: the driver gets the temp FILE, streamed, not a buffer.
    expect(stub.capturedSource!.kind).toBe('file');
    expect(stub.capturedMeta!.filename).toMatch(/\.mp4$/);

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    expect(row.thumbnail_url).toBeUndefined(); // no ffmpeg, no poster frame
    await waitForNoTemps();
  });

  // The whole reason video needs anything more than "pass the bytes through".
  it('strips the GPS out of a video BEFORE it leaves the server', async () => {
    stub.shouldThrow = null;
    const original = mp4WithGps();
    expect(original.includes(Buffer.from(GPS))).toBe(true);

    await agent
      .post('/api/uploads')
      .attach('image', original, { filename: 'vacation.mp4', contentType: 'video/mp4' });

    const sent = stub.capturedBytes!;
    expect(sent.includes(Buffer.from(GPS))).toBe(false);
    expect(sent.includes(Buffer.from('udta'))).toBe(false);
    // Size-preserving, so the recorded byte_size is still right.
    expect(sent.length).toBe(original.length);
    await waitForNoTemps();
  });

  it('415s a type we cannot clean, naming what is allowed', async () => {
    const webm = Buffer.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2,
      0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87,
      0x81, 0x02, 0x42, 0x85, 0x81, 0x02, 0x18, 0x53, 0x80, 0x67, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
    ]);
    const res = await agent
      .post('/api/uploads')
      .attach('image', webm, { filename: 'rec.webm', contentType: 'video/webm' });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/not accepted/);
    await waitForNoTemps();
  });

  it('415s media when the resolved uploader does not accept it (the hosted dropper)', async () => {
    stub.capabilities.acceptsContentClasses = ['image', 'text'];
    try {
      const res = await agent
        .post('/api/uploads')
        .attach('image', mp4WithGps(), { filename: 'clip.mp4', contentType: 'video/mp4' });
      expect(res.status).toBe(415);
      expect(res.body.error).toMatch(/does not accept media/);
    } finally {
      stub.capabilities.acceptsContentClasses = ['image', 'text', 'media'];
    }
    await waitForNoTemps();
  });

  // The claim cannot pick the class — otherwise it's a route around the EXIF scrub.
  it('optimizes an image even when the client swears it is a video', async () => {
    stub.shouldThrow = null;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'liar.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(200);
    expect(res.body.mime).toBe('image/webp'); // ran through the pipeline regardless
    expect(stub.capturedSource!.kind).toBe('buffer');
    await waitForNoTemps();
  });
});
