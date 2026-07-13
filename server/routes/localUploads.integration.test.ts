// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// End-to-end proof of the local uploader with NO registry mocking: the seeded
// self-host `local` instance row is selected via the legacy provider dropdown,
// the real driver writes to disk, the upload route absolutizes the URL, the
// public serve route streams it back, and deleting the history row reaps the
// on-disk bytes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import * as local from '../services/uploadProviders/local.js';

const ctx = setupTestDb('routes-localuploads-int');

let storageDir: string;
const prevEnv = process.env.LOCAL_UPLOADS_DIR;
let app: Express;
let agent: LurkerTestAgent;
let user: User;
let smallPng: Buffer;

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-localint-'));
  process.env.LOCAL_UPLOADS_DIR = storageDir;

  const { createUser } = await import('../db/users.js');
  const { setUserSetting } = await import('../db/settings.js');
  const { listInstanceUploaders } = await import('../db/uploaderConfig.js');
  const uploadsRouter = (await import('./uploads.js')).default;
  const localRouter = (await import('./localUploads.js')).default;

  user = createUser('localint-alice');
  // Select the seeded self-host `local` instance uploader the way the picker does
  // (#514): by uploader_config id. The legacy `uploads.provider` dropdown this
  // used to go through no longer exists.
  const localRow = listInstanceUploaders().find((r) => r.driver === 'local');
  if (!localRow) throw new Error('expected the seeded self-host local uploader row');
  setUserSetting(user.id, 'uploads.uploader_id', localRow.id);

  app = createTestApp({ '/api/uploads': uploadsRouter, '/uploads/local': localRouter });
  agent = await createAuthedAgent(app, user.id);

  smallPng = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 200, b: 90 } },
  })
    .png()
    .toBuffer();
});

afterAll(() => {
  if (prevEnv == null) delete process.env.LOCAL_UPLOADS_DIR;
  else process.env.LOCAL_UPLOADS_DIR = prevEnv;
  fs.rmSync(storageDir, { recursive: true, force: true });
  ctx.cleanup();
});

describe('local uploader — full round trip', () => {
  it('uploads to disk, serves it back, and reaps bytes on delete', async () => {
    const up = await agent
      .post('/api/uploads')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'irc.example.com')
      .attach('image', smallPng, { filename: 'photo.png', contentType: 'image/png' });

    expect(up.status).toBe(200);
    // Absolutized against the forwarded origin, pointing at our serve route.
    expect(up.body.url).toMatch(
      /^https:\/\/irc\.example\.com\/uploads\/local\/[0-9a-f]{12}\.(png|jpe?g|webp)$/,
    );

    // The image was optimized to JPEG by the pipeline and written to disk (under
    // its shard subdir).
    const servePath = new URL(up.body.url).pathname; // /uploads/local/<key>
    const key = servePath.split('/').pop()!;
    expect(fs.existsSync(local.resolveDiskPath(key))).toBe(true);

    // Serve it back through the public route with hardened headers.
    const served = await agent.get(servePath);
    expect(served.status).toBe(200);
    expect(served.headers['content-disposition']).toBe('inline');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-type']).toMatch(/^image\//);

    // Delete destroys the bytes BEFORE dropping the row (decision 8), so by the
    // time the response lands the file is gone from disk.
    const del = await agent.delete(`/api/uploads/${up.body.id}`);
    expect(del.status).toBe(200);
    expect(fs.existsSync(local.resolveDiskPath(key))).toBe(false);
  });
});
