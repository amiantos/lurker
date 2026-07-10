// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import sharp from 'sharp';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

// Resolve to node edition + operator upload config before the route reads it.
// Edition caches on first getEdition(); vitest gives this file its own process.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NODE_UPLOAD_URL = 'https://dropper.test';
process.env.LURKER_NODE_UPLOAD_API_KEY = 'operator-key-123';
// Operator-controlled pipeline limits, deliberately tighter than both the
// registry defaults and the conflicting tenant settings seeded below.
process.env.LURKER_NODE_UPLOAD_MAX_MB = '1';
process.env.LURKER_NODE_UPLOAD_MAX_DIM = '512';
process.env.LURKER_NODE_UPLOAD_QUALITY = '40';

const ctx = setupTestDb('routes-uploads-node');

// Same stub pattern as uploads.test.ts: capture the config the route hands the
// driver so we can prove the hosted uploader sources its credentials from the
// baked instance row (seeded from the operator env), never from the tenant's
// per-user settings. The configSchema mirrors hoarder (url + api_key required) so
// the resolver's "locked-but-unconfigured → 503" check has fields to test.
const stub = {
  driver: 'hoarder',
  label: 'Hosted uploader',
  capabilities: {
    storesRemotely: true,
    supportsDelete: false,
    mintsKeys: false,
    acceptsContentClasses: ['image', 'text'] as ('image' | 'text' | 'binary')[],
  },
  configSchema: [
    { key: 'url', label: 'URL', type: 'string' as const, required: true, description: '' },
    { key: 'api_key', label: 'Key', type: 'secret' as const, required: true, description: '' },
  ],
  capturedSecrets: null as Record<string, string> | null,
  // Lets a test simulate the remote thumbnail upload failing so we can assert
  // the BLOB fallback. Reset per-test by the specs that touch it.
  thumbShouldThrow: false,
  // Records the `kind` of every upload call in a request (undefined for the
  // full image, 'thumb' for the thumbnail) so we can prove the thumb is sent
  // as its own object flagged kind=thumb.
  lastKinds: [] as (string | undefined)[],
  async upload(
    _buffer: Buffer,
    meta: { filename: string; mime: string; kind?: string },
    config?: Record<string, string>,
  ) {
    stub.capturedSecrets = config ?? null;
    stub.lastKinds.push(meta.kind);
    if (meta.kind === 'thumb') {
      if (stub.thumbShouldThrow) {
        throw Object.assign(new Error('thumb store down'), { code: 'PROVIDER_ERROR' });
      }
      return { url: `https://stub.example/thumbs/${meta.filename}` };
    }
    return { url: `https://stub.example/${meta.filename}` };
  },
};

vi.mock('../services/uploadProviders/index.js', () => ({
  driverIds: ['x0', 'catbox', 'hoarder'],
  getDriver: () => stub,
  secretFieldKeys: () => ['api_key'],
  splitConfigBySchema: (_driver: unknown, values: Record<string, string>) => ({
    config: values,
    secrets: {},
  }),
}));

// Mock the sharp pipeline so we can capture the maxDim/quality the route passes
// it (the real pipeline runs in uploads.test.ts). Lets us assert those come
// from the operator env, not the tenant's settings.
const pipelineCapture = {
  opts: null as { maxDim: number; quality: number; rasterOnly?: boolean } | null,
};
vi.mock('../services/imagePipeline.js', () => ({
  optimize: async (
    _buf: Buffer,
    opts: { maxDim: number; quality: number; rasterOnly?: boolean },
  ) => {
    pipelineCapture.opts = opts;
    return {
      buffer: Buffer.from('x'),
      mime: 'image/jpeg',
      ext: 'jpg',
      byteSize: 1,
      width: 10,
      height: 10,
    };
  },
  // A non-empty buffer so the route exercises the (node-edition) remote thumb
  // upload + BLOB-fallback paths.
  thumbnail: async () => Buffer.from('fake-jpeg-thumb-bytes'),
}));

let app: Express;
let agent: LurkerTestAgent;
let user: User;
let smallPng: Buffer;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { setUserSetting } = await import('../db/settings.js');
  const router = (await import('./uploads.js')).default;

  user = createUser('upload-node-alice');
  // Non-default tenant choices that node edition must IGNORE: a different
  // provider, and pipeline limits looser than the operator env above.
  setUserSetting(user.id, 'uploads.provider', 'catbox');
  setUserSetting(user.id, 'uploads.image.max_upload_mb', 200);
  setUserSetting(user.id, 'uploads.image.max_dimension', 8192);
  setUserSetting(user.id, 'uploads.image.quality', 100);

  app = createTestApp({ '/api/uploads': router });
  agent = await createAuthedAgent(app, user.id);

  smallPng = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
});

afterAll(() => {
  ctx.cleanup();
  delete process.env.LURKER_EDITION;
  delete process.env.LURKER_NODE_UPLOAD_URL;
  delete process.env.LURKER_NODE_UPLOAD_API_KEY;
  delete process.env.LURKER_NODE_UPLOAD_MAX_MB;
  delete process.env.LURKER_NODE_UPLOAD_MAX_DIM;
  delete process.env.LURKER_NODE_UPLOAD_QUALITY;
});

describe('POST /api/uploads (node edition)', () => {
  it('forces the in-house provider regardless of the tenant setting', async () => {
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(200);

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    // Recorded as the forced in-house provider, not the tenant's 'catbox' pick.
    expect(row.provider).toBe('hoarder');
  });

  it('hands the provider operator env credentials, not per-user settings', async () => {
    stub.capturedSecrets = null;
    await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'creds.png', contentType: 'image/png' });
    expect(stub.capturedSecrets).toEqual({
      url: 'https://dropper.test',
      api_key: 'operator-key-123',
    });
  });

  it('503s with a clear message (no per-user key names) when the operator env is unset', async () => {
    // The hosted config now lives in the baked instance row, not read from env
    // per-request. An operator who boots with the env unset gets an unconfigured
    // locked uploader → the resolver's locked-but-unconfigured check → 503. We
    // simulate that boot by reconciling the row from a cleared env.
    const { default: db } = await import('../db/index.js');
    const { reconcileHostedUploaderFromEnv } = await import('../db/uploaderConfigSeed.js');
    const savedUrl = process.env.LURKER_NODE_UPLOAD_URL;
    const savedKey = process.env.LURKER_NODE_UPLOAD_API_KEY;
    delete process.env.LURKER_NODE_UPLOAD_URL;
    delete process.env.LURKER_NODE_UPLOAD_API_KEY;
    reconcileHostedUploaderFromEnv(db);
    try {
      const res = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'noconfig.png', contentType: 'image/png' });
      expect(res.status).toBe(503);
      // Must not leak the per-user hoarder settings a tenant can't configure.
      expect(res.body.error).not.toMatch(/uploads\.hoarder/);
    } finally {
      process.env.LURKER_NODE_UPLOAD_URL = savedUrl;
      process.env.LURKER_NODE_UPLOAD_API_KEY = savedKey;
      reconcileHostedUploaderFromEnv(db);
    }
  });

  it('caps upload size by the operator env, ignoring the higher tenant setting', async () => {
    // Tenant set 200 MB; operator env caps at 1 MB, so a ~2 MB upload must 413.
    const big = Buffer.alloc(2 * 1024 * 1024, 1);
    const res = await agent
      .post('/api/uploads')
      .attach('image', big, { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
  });

  it('uses operator env dimension + quality for the pipeline, ignoring tenant settings', async () => {
    pipelineCapture.opts = null;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'dims.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    // Operator env (512 / 40), not the tenant's 8192 / 100. rasterOnly is on in
    // node edition (raster + .txt only; SVG rejected).
    expect(pipelineCapture.opts).toEqual({ maxDim: 512, quality: 40, rasterOnly: true });
  });

  it('stores the thumbnail as a remote thumbs/ object, not an inline BLOB', async () => {
    stub.thumbShouldThrow = false;
    stub.lastKinds = [];
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'thumbed.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    // The POST response advertises the remote thumbnail immediately so the
    // client never round-trips through the cell for it.
    expect(res.body.thumbnail_url).toMatch(/^https:\/\/stub\.example\/thumbs\//);
    // The thumb went up as its own object flagged kind=thumb.
    expect(stub.lastKinds).toContain('thumb');

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    expect(row.thumbnail_url).toMatch(/^https:\/\/stub\.example\/thumbs\//);
    // No inline BLOB was stored, so the local thumb route has nothing to serve.
    const thumbRes = await agent.get(`/api/uploads/${res.body.id}/thumb`);
    expect(thumbRes.status).toBe(404);
  });

  it('falls back to an inline BLOB when the remote thumb upload fails', async () => {
    stub.thumbShouldThrow = true;
    stub.lastKinds = [];
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'fallback.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    // A thumb hiccup must never block the user's upload, and no remote
    // thumbnail is advertised.
    expect(res.body.thumbnail_url).toBeUndefined();
    stub.thumbShouldThrow = false;

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    // GET falls back to the local BLOB-serving route, which now serves bytes.
    expect(row.thumbnail_url).toBe(`/api/uploads/${res.body.id}/thumb`);
    const thumbRes = await agent.get(`/api/uploads/${res.body.id}/thumb`);
    expect(thumbRes.status).toBe(200);
    expect(thumbRes.headers['content-type']).toBe('image/jpeg');
  });
});
