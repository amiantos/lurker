// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PassThrough } from 'stream';
import Database from 'better-sqlite3';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const ctx = setupTestDb('routes-exports');

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let alice: User;
let bob: User;
let aliceNet: Network;

let buildExportZip: typeof import('../services/exportService.js').buildExportZip;

// Build an export buffer to attach to the import tests. A one-shot read on a
// throwaway connection — no concurrent writers, so a readonly handle is fine.
async function exportToBuffer(userId: number, includeMessages: boolean): Promise<Buffer> {
  const reader = new Database(ctx.dbPath, { readonly: true });
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  try {
    await buildExportZip(reader, userId, { includeMessages }, sink);
  } finally {
    reader.close();
  }
  return Buffer.concat(chunks);
}

function waitForStatus(agent: LurkerTestAgent, want: string, timeoutMs = 5000): Promise<any> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const res = await agent.get('/api/exports/latest');
      const job = res.body.job;
      if (job && (job.status === want || job.status === 'error')) return resolve(job);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${want}`));
      setTimeout(tick, 15);
    };
    void tick();
  });
}

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  const { exportsRouter, importRouter } = await import('./exports.js');
  ({ buildExportZip } = await import('../services/exportService.js'));

  alice = createUser('exports-alice');
  bob = createUser('exports-bob');
  aliceNet = createNetwork(alice.id, {
    name: 'libera',
    host: 'irc.libera.chat',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!;
  for (let i = 0; i < 3; i += 1) {
    insertMessage({
      networkId: aliceNet.id,
      target: '#general',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'alice',
      text: `msg ${i}`,
      self: i % 2 === 0,
    });
  }
  app = createTestApp({ '/api/exports': exportsRouter, '/api/imports': importRouter });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
});

afterAll(() => {
  ctx.cleanup();
});

describe('GET /api/exports/preview', () => {
  it('requires auth', async () => {
    const res = await createAnonAgent(app).get('/api/exports/preview');
    expect(res.status).toBe(401);
  });

  it('returns row counts for both settings-only and with-messages', async () => {
    const res = await aliceAgent.get('/api/exports/preview');
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('exports-alice');
    const so = (Object.values(res.body.settingsOnly) as number[]).reduce((s, n) => s + n, 0);
    const wm = (Object.values(res.body.withMessages) as number[]).reduce((s, n) => s + n, 0);
    expect(wm).toBeGreaterThanOrEqual(so);
  });
});

describe('export job flow', () => {
  it('requires auth to start', async () => {
    const res = await createAnonAgent(app).post('/api/exports').send({ include_messages: true });
    expect(res.status).toBe(401);
  });

  it('starts a build, finishes it, and serves the artifact', async () => {
    const start = await aliceAgent.post('/api/exports').send({ include_messages: true });
    expect(start.status).toBe(202);
    expect(['pending', 'running', 'done']).toContain(start.body.job.status);
    const jobId = start.body.job.id;

    const done = await waitForStatus(aliceAgent, 'done');
    expect(done.status).toBe('done');
    expect(done.id).toBe(jobId);
    expect(done.byteSize).toBeGreaterThan(0);
    expect(done.downloadable).toBe(true);

    const dl = await aliceAgent
      .get(`/api/exports/${jobId}/download`)
      .buffer(true)
      .parse((stream, cb) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment/);
    expect((dl.body as Buffer).slice(0, 2).toString()).toBe('PK');
  });

  it("refuses to download another user's export", async () => {
    const start = await aliceAgent.post('/api/exports').send({ include_messages: false });
    const jobId = start.body.job.id;
    await waitForStatus(aliceAgent, 'done');
    const res = await bobAgent.get(`/api/exports/${jobId}/download`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/imports', () => {
  it('requires a file', async () => {
    const res = await aliceAgent.post('/api/imports');
    expect(res.status).toBe(400);
  });

  it('rejects a non-zip body with code=not_a_zip', async () => {
    const res = await aliceAgent
      .post('/api/imports')
      .attach('archive', Buffer.from('hello not a zip'), { filename: 'fake.lurk' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_a_zip');
  });

  it('refuses import when the account already has data', async () => {
    const buf = await exportToBuffer(alice.id, true);
    const res = await aliceAgent
      .post('/api/imports')
      .attach('archive', buf, { filename: 'export.lurk' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account_not_empty');
  });

  it('round-trips an export into a fresh account', async () => {
    const { createUser } = await import('../db/users.js');
    const carol = createUser('exports-carol');
    const carolAgent = await createAuthedAgent(app, carol.id);
    const buf = await exportToBuffer(alice.id, true);

    const res = await carolAgent
      .post('/api/imports')
      .attach('archive', buf, { filename: 'alice.lurk' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { listNetworksForUser } = await import('../db/networks.js');
    const { listMessages } = await import('../db/messages.js');
    const carolNets = listNetworksForUser(carol.id);
    expect(carolNets.length).toBe(1);
    expect(carolNets[0].name).toBe('libera');
    const carolMsgs = listMessages(carolNets[0].id, '#general', { limit: 100 });
    expect(carolMsgs.length).toBe(3);
  });
});
