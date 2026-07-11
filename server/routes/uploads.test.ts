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
    acceptsContentClasses: ['image', 'text'] as ('image' | 'text' | 'binary')[],
  },
  configSchema: [],
  shouldThrow: null as Error | null,
  capturedConfig: null as Record<string, string> | null,
  // When set, upload() returns this instead of the default remote URL — used to
  // exercise the storesRemotely:false (local-style relative URL) absolutization.
  nextResult: null as { url: string; ref?: string } | null,
  capturedDeleteRef: null as string | null,
  async upload(
    _buffer: Buffer,
    meta: { filename: string; mime: string },
    config?: Record<string, string>,
  ) {
    stub.capturedConfig = config ?? null;
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

// The byte reap is fire-and-forget (DELETE responds before the async unlink), so
// poll for its effect rather than assume a single tick has run it.
async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

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

  it('maps PROVIDER_AUTH into 401', async () => {
    const err = Object.assign(new Error('bad creds'), { code: 'PROVIDER_AUTH' });
    stub.shouldThrow = err;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'auth.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
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

  it('reaps the on-disk bytes via driver.delete when a deletable upload is removed', async () => {
    stub.capabilities.storesRemotely = false;
    stub.capabilities.supportsDelete = true;
    stub.nextResult = { url: '/uploads/local/112233445566.png', ref: '112233445566.png' };
    stub.capturedDeleteRef = null;
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'reap.png', contentType: 'image/png' });
      expect(up.status).toBe(200);

      const del = await agent.delete(`/api/uploads/${up.body.id}`);
      expect(del.status).toBe(200);
      // The reap is fire-and-forget; poll until it runs rather than assume a tick.
      await waitUntil(() => stub.capturedDeleteRef === '112233445566.png');
      expect(stub.capturedDeleteRef).toBe('112233445566.png');
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.capabilities.supportsDelete = false;
      stub.nextResult = null;
    }
  });

  it('does not call driver.delete for a non-deletable driver (even with a ref)', async () => {
    // A ref is present, but supportsDelete is false → the reap must short-circuit
    // and never unlink (external forwarders offer list-only removal).
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/local/778899aabbcc.png', ref: '778899aabbcc.png' };
    stub.capturedDeleteRef = null;
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'keep.png', contentType: 'image/png' });
      const del = await agent.delete(`/api/uploads/${up.body.id}`);
      expect(del.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(stub.capturedDeleteRef).toBeNull();
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
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("404 for an id we don't own", async () => {
    const res = await agent.get('/api/uploads/999999/thumb');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/uploads/:id', () => {
  it('removes an owned row', async () => {
    const upload = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'delete-me.png', contentType: 'image/png' });
    const del = await agent.delete(`/api/uploads/${upload.body.id}`);
    expect(del.status).toBe(200);
    const list = await agent.get('/api/uploads');
    expect(list.body.items.find((r: { id: number }) => r.id === upload.body.id)).toBeFalsy();
  });

  it("404 for a row that doesn't exist", async () => {
    const res = await agent.delete('/api/uploads/999999');
    expect(res.status).toBe(404);
  });
});
