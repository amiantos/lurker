// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

// Deleting a hosted upload (node edition, control-plane #55): the cell asks the
// control plane, which holds the delete key. Edition caches on first read, and
// vitest gives this file its own process.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NODE_UPLOAD_URL = 'https://dropper.test';
process.env.LURKER_NODE_UPLOAD_API_KEY = 'operator-key-123';
process.env.LURKER_NODE_NAME = 'cell-7';
process.env.LURKER_NODE_SECRET = 'fleet-secret';

const ctx = setupTestDb('routes-uploads-hosted-delete');

// A stand-in control plane: the owner-delete endpoint answers whatever the test
// sets, and the report endpoint records what it's sent.
type Answer = {
  status: number;
  body: Record<string, unknown> | string;
  headers?: Record<string, string>;
  delayMs?: number;
};
let deleteAnswers: Answer[] = [];
const deleteCalls: { auth?: string; body: Record<string, unknown> }[] = [];
const reports: Record<string, unknown>[] = [];
// When set, the report endpoint is down: what a cell sees while the control
// plane is out, so rows stay unsynced.
let reportsDown = false;
let cp: http.Server;

function startFakeCp(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post('/_cp/moderation/uploads/delete', (req, res) => {
    deleteCalls.push({ auth: req.headers.authorization, body: req.body });
    const a: Answer = deleteAnswers.shift() ?? {
      status: 200,
      body: { ok: true, cdn_purged: true },
    };
    setTimeout(() => {
      for (const [k, v] of Object.entries(a.headers ?? {})) res.set(k, v);
      if (typeof a.body === 'string') res.status(a.status).type('text/plain').send(a.body);
      else res.status(a.status).json(a.body);
    }, a.delayMs ?? 0);
  });
  app.post('/_cp/moderation/uploads', (req, res) => {
    if (reportsDown) {
      res.status(503).json({ error: 'down' });
      return;
    }
    reports.push(req.body);
    res.json({ ok: true });
  });
  return new Promise((resolve) => {
    cp = app.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(cp.address() as AddressInfo).port}`),
    );
  });
}

let app: Express;
let agent: LurkerTestAgent;
let adminAgent: LurkerTestAgent;
let adminId: number;
let userId: number;
let otherUserId: number;
let history: typeof import('../db/uploadHistory.js');

beforeAll(async () => {
  process.env.LURKER_ORCHESTRATOR_URL = await startFakeCp();
  const { createUser } = await import('../db/users.js');
  history = await import('../db/uploadHistory.js');
  const router = (await import('./uploads.js')).default;
  userId = createUser('hosted-delete-alice').id;
  otherUserId = createUser('hosted-delete-bob').id;
  app = createTestApp({ '/api/uploads': router });
  agent = await createAuthedAgent(app, userId);
  // The operator's own account on the cell: no control-plane account behind it.
  adminId = createUser('hosted-delete-operator', { role: 'admin' }).id;
  adminAgent = await createAuthedAgent(app, adminId);
});

afterAll(() => {
  cp.close();
  ctx.cleanup();
});

beforeEach(() => {
  deleteAnswers = [];
  deleteCalls.length = 0;
  reports.length = 0;
  reportsDown = false;
});

let n = 0;
// A hosted upload as the dropper leaves one: a CDN URL and thumbnail, no ref.
function hostedUpload(
  owner = userId,
  provider = 'dropper',
  uploaderConfigId: number | null = null,
): number {
  n += 1;
  return history.insertUpload(owner, {
    provider,
    uploader_config_id: uploaderConfigId,
    url: `https://cdn.test/f${n}.png`,
    mime: 'image/png',
    byte_size: 100,
    width: 16,
    height: 16,
    thumbnail: null,
    thumbnail_url: `https://cdn.test/thumbs/f${n}.png`,
  });
}

const exists = (id: number) => history.getUploadForReap(userId, id) !== undefined;

describe('hosted upload delete (node edition, control-plane #55)', () => {
  it('offers delete on hosted rows, though the dropper captured no delete handle', async () => {
    const id = hostedUpload();
    const res = await agent.get('/api/uploads');
    expect(res.status).toBe(200);
    expect(res.body.items.find((i: { id: number }) => i.id === id).can_delete).toBe(true);
  });

  it('asks the control plane, then drops the row once it says the bytes are gone', async () => {
    const id = hostedUpload();
    const res = await agent.delete(`/api/uploads/${id}`);
    expect(res.status).toBe(200);
    expect(deleteCalls).toEqual([
      {
        auth: 'Bearer fleet-secret',
        body: { cell: 'cell-7', cell_user_id: userId, cell_upload_id: id },
      },
    ]);
    expect(exists(id)).toBe(false);
  });

  it('reports an upload the control plane has not indexed yet, then asks again', async () => {
    const id = hostedUpload();
    deleteAnswers = [
      { status: 404, body: { code: 'not_indexed', error: 'upload not indexed yet' } },
    ];
    const res = await agent.delete(`/api/uploads/${id}`);
    expect(res.status).toBe(200);
    expect(reports).toEqual([
      expect.objectContaining({
        cell: 'cell-7',
        cell_upload_id: id,
        cell_user_id: userId,
        url: `https://cdn.test/f${n}.png`,
        thumb_url: `https://cdn.test/thumbs/f${n}.png`,
      }),
    ]);
    expect(deleteCalls).toHaveLength(2);
    expect(exists(id)).toBe(false);
  });

  it.each([
    [{ status: 409, body: { code: 'taken_down' } }, 409, /removed by moderation/],
    [{ status: 502, body: { code: 'storage_unavailable' } }, 502, /try again/],
    [{ status: 403, body: { code: 'not_from_cell' } }, 502, /could not delete/],
    [{ status: 403, body: { code: 'not_owner' } }, 409, /cannot be deleted/],
    // A proxy's answer has no JSON: the status alone still says what happened.
    [{ status: 409, body: 'Conflict' }, 409, /removed by moderation/],
    [{ status: 503, body: { code: 'storage_unconfigured' } }, 503, /could not delete/],
  ])('keeps the row when the control plane refuses (%j → %i)', async (answer, status, message) => {
    const id = hostedUpload();
    deleteAnswers = [answer];
    const res = await agent.delete(`/api/uploads/${id}`);
    expect(res.status).toBe(status);
    expect(res.body.error).toMatch(message);
    expect(exists(id)).toBe(true);
  });

  it('passes a rate limit on, with its Retry-After', async () => {
    const id = hostedUpload();
    deleteAnswers = [
      { status: 429, body: { code: 'rate_limited' }, headers: { 'Retry-After': '17' } },
    ];
    const res = await agent.delete(`/api/uploads/${id}`);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('17');
    expect(exists(id)).toBe(true);
  });

  it('keeps the row when the control plane cannot be reached', async () => {
    const id = hostedUpload();
    const saved = process.env.LURKER_ORCHESTRATOR_URL;
    process.env.LURKER_ORCHESTRATOR_URL = 'http://127.0.0.1:9'; // nothing listens on discard
    try {
      const res = await agent.delete(`/api/uploads/${id}`);
      expect(res.status).toBe(502);
    } finally {
      process.env.LURKER_ORCHESTRATOR_URL = saved;
    }
    expect(exists(id)).toBe(true);
  });

  it("never asks about another user's upload, or one taken down", async () => {
    const theirs = hostedUpload(otherUserId);
    expect((await agent.delete(`/api/uploads/${theirs}`)).status).toBe(404);

    const removed = hostedUpload();
    history.markUploadRemovedById(removed);
    expect((await agent.delete(`/api/uploads/${removed}`)).status).toBe(409);
    expect(deleteCalls).toEqual([]);
  });

  it('passes on a bare 429 from a proxy, Retry-After and all', async () => {
    const id = hostedUpload();
    deleteAnswers = [{ status: 429, body: 'Too Many Requests', headers: { 'Retry-After': '5' } }];
    const res = await agent.delete(`/api/uploads/${id}`);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('deletes rows from before the dropper was renamed (provider hoarder)', async () => {
    const id = hostedUpload(userId, 'hoarder');
    expect((await agent.delete(`/api/uploads/${id}`)).status).toBe(200);
    expect(exists(id)).toBe(false);
  });

  it('leaves rows from any other uploader to their own driver', async () => {
    const id = hostedUpload(userId, 'catbox');
    const list = await agent.get('/api/uploads');
    expect(list.body.items.find((i: { id: number }) => i.id === id).can_delete).toBe(false);
    expect((await agent.delete(`/api/uploads/${id}`)).status).toBe(409);
    expect(deleteCalls).toEqual([]);
  });

  it("offers no hosted delete to the cell's admin, who has no control-plane account", async () => {
    const id = hostedUpload(adminId);
    const list = await adminAgent.get('/api/uploads');
    expect(list.body.items.find((i: { id: number }) => i.id === id).can_delete).toBe(false);
    expect((await adminAgent.delete(`/api/uploads/${id}`)).status).toBe(409);
    expect(deleteCalls).toEqual([]);
  });

  // #1289: dropping the record never asks the control plane to delete — the
  // bytes stay in the bucket and only this user's row goes. Another user's row
  // is not reachable.
  it('drops a hosted record without a delete request, and only its owner can', async () => {
    const id = hostedUpload();
    history.markUploadSynced(id);
    expect((await adminAgent.delete(`/api/uploads/${id}/record`)).status).toBe(404);
    expect(exists(id)).toBe(true);
    expect((await agent.delete(`/api/uploads/${id}/record`)).status).toBe(200);
    expect(exists(id)).toBe(false);
    expect(deleteCalls).toEqual([]);
    expect(reports).toEqual([]);
  });

  // The row is the only copy of the report the control plane never got (it was
  // down at upload time). The file outlives the row, so the report lands first
  // — or the row stays until it can.
  it('reports a still-unsynced row before dropping it, and keeps it while it cannot', async () => {
    const id = hostedUpload();
    reportsDown = true;
    const res = await agent.delete(`/api/uploads/${id}/record`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/still being recorded/);
    expect(exists(id)).toBe(true);

    reportsDown = false;
    expect((await agent.delete(`/api/uploads/${id}/record`)).status).toBe(200);
    expect(exists(id)).toBe(false);
    expect(reports.map((r) => r.cell_upload_id)).toEqual([id]);
    expect(deleteCalls).toEqual([]);
  });

  it('a double tap asks the control plane once', async () => {
    const id = hostedUpload();
    deleteAnswers = [{ status: 200, body: { ok: true, cdn_purged: true }, delayMs: 100 }];
    const [a, b] = await Promise.all([
      agent.delete(`/api/uploads/${id}`),
      agent.delete(`/api/uploads/${id}`),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(deleteCalls).toHaveLength(1);
  });

  it('deletes uploads the hosted uploader recorded itself', async () => {
    const { getHostedUploaderId } = await import('../db/uploaderConfig.js');
    const hostedId = getHostedUploaderId();
    expect(hostedId).not.toBeNull(); // seeded from the operator env on a node
    const id = hostedUpload(userId, 'dropper', hostedId);
    expect((await agent.delete(`/api/uploads/${id}`)).status).toBe(200);
    expect(exists(id)).toBe(false);
  });

  it("leaves a dropper row from the user's own uploader (an imported archive) to its driver", async () => {
    const { getHostedUploaderId } = await import('../db/uploaderConfig.js');
    const theirOwn = (getHostedUploaderId() as number) + 1000;
    const id = hostedUpload(userId, 'dropper', theirOwn);
    const list = await agent.get('/api/uploads');
    expect(list.body.items.find((i: { id: number }) => i.id === id).can_delete).toBe(false);
    expect((await agent.delete(`/api/uploads/${id}`)).status).toBe(409);
    expect(deleteCalls).toEqual([]);
  });

  it('keeps the tombstone when a takedown lands while the control plane is answering', async () => {
    const id = hostedUpload();
    deleteAnswers = [{ status: 200, body: { ok: true, cdn_purged: true }, delayMs: 150 }];
    const pending = agent.delete(`/api/uploads/${id}`).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    history.markUploadRemovedById(id); // the control plane's takedown push
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/removed by moderation/);
    expect(history.getUploadForReap(userId, id)?.removed).toBe(1);
  });
});
