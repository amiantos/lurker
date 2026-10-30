// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Chunked, resumable uploads (#650), through the real router and a stub
// uploader. Chunks are a few bytes here (setUploadChunkBytesForTests), so the
// cost of these doesn't grow with the 16 MiB a real chunk is.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'node:fs';
import sharp from 'sharp';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { UploadSource } from '../services/uploadProviders/source.js';
import type { ContentClass } from '../services/uploadProviders/types.js';

const ctx = setupTestDb('routes-upload-sessions');

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
  received: null as Buffer | null,
  async upload(source: UploadSource, meta: { filename: string }) {
    stub.received =
      source.kind === 'file' ? fs.readFileSync(source.path) : Buffer.from(source.data);
    return { url: `https://stub.example/${meta.filename}` };
  },
};

vi.mock('../services/uploadProviders/index.js', () => ({
  driverIds: ['x0', 'catbox'],
  getDriver: () => stub,
  splitConfigBySchema: (_driver: unknown, values: Record<string, string>) => ({
    config: values,
    secrets: {},
  }),
}));

const CHUNK = 16;

let app: Express;
let alice: LurkerTestAgent;
let bob: LurkerTestAgent;
let aliceId: number;
let sessions: typeof import('../services/uploadSessions.js');
let limits: typeof import('../services/uploadLimits.js');

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./uploadSessions.js')).default;
  sessions = await import('../services/uploadSessions.js');
  limits = await import('../services/uploadLimits.js');
  limits.setUploadChunkBytesForTests(CHUNK);
  aliceId = createUser('sess-alice').id;
  const bobId = createUser('sess-bob').id;
  app = createTestApp({ '/api/upload-sessions': router });
  alice = await createAuthedAgent(app, aliceId);
  bob = await createAuthedAgent(app, bobId);
});

afterAll(() => {
  limits.setUploadChunkBytesForTests(null);
  ctx.cleanup();
});

afterEach(() => {
  delete process.env.LURKER_MAX_UPLOAD_MB;
});

const text = (n: number) => Buffer.from('lorem ipsum dolor sit amet\n'.repeat(n));

async function open(body: Record<string, unknown>, agent = alice) {
  return agent.post('/api/upload-sessions').send(body);
}

function put(id: string, offset: number | string, bytes: Buffer, agent = alice) {
  return agent
    .put(`/api/upload-sessions/${id}`)
    .set('Upload-Offset', String(offset))
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
}

/** Send `bytes` a chunk at a time from `from`. */
async function sendAll(id: string, bytes: Buffer, from = 0) {
  for (let at = from; at < bytes.length; at += CHUNK) {
    const res = await put(id, at, bytes.subarray(at, at + CHUNK));
    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(Math.min(at + CHUNK, bytes.length));
  }
}

describe('/api/upload-sessions', () => {
  it('takes a file in chunks and hands the whole of it to the uploader', async () => {
    const file = text(5);
    const created = await open({
      purpose: 'upload',
      size: file.length,
      filename: 'notes.txt',
      mime: 'text/plain',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ purpose: 'upload', size: file.length, offset: 0 });
    expect(created.body.chunkBytes).toBe(CHUNK);
    const { id } = created.body;

    await sendAll(id, file);
    const done = await alice.post(`/api/upload-sessions/${id}/complete`).send({});
    expect(done.status).toBe(200);
    expect(done.body.url).toMatch(/^https:\/\/stub\.example\/.*\.txt$/);
    expect(stub.received!.equals(file)).toBe(true);

    // The file is handed on and gone; the session keeps the answer, for a
    // client whose connection dropped before it arrived.
    await new Promise((r) => setTimeout(r, 20)); // the unlink is fire-and-forget
    expect(fs.existsSync(sessions.uploadSessionPath(id))).toBe(false);
    const after = await alice.get(`/api/upload-sessions/${id}`);
    expect(after.body).toMatchObject({ state: 'done', offset: file.length });
    expect(after.body.result).toEqual({ status: 200, body: done.body });
  });

  // Finishing can outlast a proxy's patience, and the client asks again.
  it('answers complete again with the same answer, without handing the file on twice', async () => {
    const file = text(2);
    const { id } = (await open({ purpose: 'upload', size: file.length, filename: 'twice.txt' }))
      .body;
    await sendAll(id, file);
    const first = await alice.post(`/api/upload-sessions/${id}/complete`).send({});
    stub.received = null;
    const second = await alice.post(`/api/upload-sessions/${id}/complete`).send({});
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(stub.received).toBeNull();
    const late = await put(id, file.length, Buffer.from('x'));
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('session_closed');
  });

  it('answers a chunk at the wrong offset with the real one, and resumes from it', async () => {
    const file = text(3);
    const { id } = (await open({ purpose: 'upload', size: file.length, filename: 'a.txt' })).body;
    await put(id, 0, file.subarray(0, CHUNK));

    // A client that lost track (sent the first chunk again, or skipped one).
    for (const wrong of [0, CHUNK * 2, 'abc']) {
      const res = await put(id, wrong, file.subarray(0, CHUNK));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'offset_mismatch', offset: CHUNK });
    }
    const status = await alice.get(`/api/upload-sessions/${id}`);
    expect(status.body).toMatchObject({ offset: CHUNK, size: file.length });

    await sendAll(id, file, status.body.offset);
    expect((await alice.post(`/api/upload-sessions/${id}/complete`).send({})).status).toBe(200);
    expect(stub.received!.equals(file)).toBe(true);
  });

  it('refuses a chunk larger than a chunk, or past the end of the file', async () => {
    const { id } = (await open({ purpose: 'upload', size: CHUNK + 4, filename: 'b.txt' })).body;
    const big = await put(id, 0, Buffer.alloc(CHUNK + 1, 97));
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({ code: 'chunk_too_large', offset: 0 });

    await put(id, 0, Buffer.alloc(CHUNK, 97));
    const past = await put(id, CHUNK, Buffer.alloc(5, 97));
    expect(past.status).toBe(413);
    expect((await alice.get(`/api/upload-sessions/${id}`)).body.offset).toBe(CHUNK);
  });

  it('refuses to finish a session short of its size, and keeps it', async () => {
    const { id } = (await open({ purpose: 'upload', size: 40, filename: 'c.txt' })).body;
    await put(id, 0, Buffer.alloc(CHUNK, 97));
    const res = await alice.post(`/api/upload-sessions/${id}/complete`).send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'incomplete', offset: CHUNK });
    expect((await alice.get(`/api/upload-sessions/${id}`)).status).toBe(200);
  });

  it('refuses a file over the cap before a byte is sent', async () => {
    const { setUserSetting } = await import('../db/settings.js');
    setUserSetting(aliceId, 'uploads.image.max_upload_mb', 1);
    try {
      const res = await open({ purpose: 'upload', size: 2 * 1024 * 1024, filename: 'big.bin' });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('file exceeds 1 MB');
    } finally {
      setUserSetting(aliceId, 'uploads.image.max_upload_mb', 200);
    }
  });

  // The point of all this: a proxy's body limit caps a chunk, not the file.
  it('takes a file larger than the proxy in front of the server allows', async () => {
    process.env.LURKER_MAX_UPLOAD_MB = '1';
    limits.setUploadChunkBytesForTests(512 * 1024);
    try {
      const file = text(45_000); // 1.2 MB
      expect(file.length).toBeGreaterThan(limits.transportCapBytes());
      const { id, chunkBytes } = (
        await open({ purpose: 'upload', size: file.length, filename: 'long.txt' })
      ).body;
      for (let at = 0; at < file.length; at += chunkBytes) {
        expect((await put(id, at, file.subarray(at, at + chunkBytes))).status).toBe(200);
      }
      const done = await alice.post(`/api/upload-sessions/${id}/complete`).send({});
      expect(done.status).toBe(200);
      expect(stub.received!.length).toBe(file.length);
    } finally {
      limits.setUploadChunkBytesForTests(CHUNK);
    }
  });

  it("crops an avatar's image square, as the single request does (#1189)", async () => {
    const png = await sharp({
      create: { width: 30, height: 20, channels: 3, background: { r: 0, g: 128, b: 255 } },
    })
      .png()
      .toBuffer();
    const created = await open({
      purpose: 'avatar',
      size: png.length,
      filename: 'me.png',
      mime: 'image/png',
    });
    expect(created.status).toBe(201);
    await sendAll(created.body.id, png);
    const done = await alice.post(`/api/upload-sessions/${created.body.id}/complete`).send({});
    expect(done.status).toBe(200);
    const meta = await sharp(stub.received!).metadata();
    expect([meta.width, meta.height]).toEqual([20, 20]);
  });

  it('is invisible to another account', async () => {
    const { id } = (await open({ purpose: 'upload', size: 10, filename: 'd.txt' })).body;
    expect((await bob.get(`/api/upload-sessions/${id}`)).status).toBe(404);
    expect((await put(id, 0, Buffer.alloc(10, 97), bob)).status).toBe(404);
    expect((await bob.post(`/api/upload-sessions/${id}/complete`).send({})).status).toBe(404);
    expect((await bob.delete(`/api/upload-sessions/${id}`)).status).toBe(404);
    expect((await alice.get(`/api/upload-sessions/${id}`)).status).toBe(200);
  });

  it('drops the session and its file on DELETE', async () => {
    const { id } = (await open({ purpose: 'upload', size: 40, filename: 'e.txt' })).body;
    await put(id, 0, Buffer.alloc(CHUNK, 97));
    expect((await alice.delete(`/api/upload-sessions/${id}`)).body).toEqual({ ok: true });
    expect((await alice.get(`/api/upload-sessions/${id}`)).status).toBe(404);
    await new Promise((r) => setTimeout(r, 20)); // the unlink is fire-and-forget
    expect(fs.existsSync(sessions.uploadSessionPath(id))).toBe(false);
  });

  it('400s a session it cannot make sense of', async () => {
    for (const bad of [
      { purpose: 'dcc', size: 10, filename: 'x' },
      { purpose: 'upload', size: 0, filename: 'x' },
      { purpose: 'upload', size: 1.5, filename: 'x' },
      { purpose: 'upload', size: '10', filename: 'x' },
      { purpose: 'upload', size: 10 },
      { purpose: 'upload', size: 10, filename: 'x', uploaderId: 'one' },
      { purpose: 'import', size: 10, filename: 'x', uploaderId: 1 },
    ]) {
      expect((await open(bad)).status).toBe(400);
    }
  });

  describe('an import', () => {
    it('is refused up front for an account that already has data', async () => {
      const { createUser } = await import('../db/users.js');
      const { createNetwork } = await import('../db/networks.js');
      const carol = createUser('sess-carol');
      createNetwork(carol.id, { name: 'n', host: 'irc.example', port: 6697, tls: true, nick: 'c' });
      const agent = await createAuthedAgent(app, carol.id);
      const res = await open({ purpose: 'import', size: 100, filename: 'a.lurk' }, agent);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('account_not_empty');
    });

    it('takes up to the import limit, whatever the proxy', async () => {
      process.env.LURKER_MAX_UPLOAD_MB = '100';
      const over = await open({
        purpose: 'import',
        size: limits.MAX_IMPORT_BYTES + 1,
        filename: 'a.lurk',
      });
      expect(over.status).toBe(413);
      expect(over.body.code).toBe('archive_too_large');
      const at = await open({
        purpose: 'import',
        size: limits.MAX_IMPORT_BYTES,
        filename: 'a.lurk',
      });
      expect(at.status).toBe(201);
      await alice.delete(`/api/upload-sessions/${at.body.id}`);
    });

    it('hands the archive to the importer', async () => {
      const junk = Buffer.from('not a zip at all, sorry');
      const { id } = (await open({ purpose: 'import', size: junk.length, filename: 'x.lurk' }))
        .body;
      await sendAll(id, junk);
      const res = await alice.post(`/api/upload-sessions/${id}/complete`).send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('not_a_zip');
      const after = await alice.get(`/api/upload-sessions/${id}`);
      expect(after.body.result).toEqual({ status: 400, body: res.body });
    });
  });

  // #1086: a file uploaded to send over DCC becomes one of the account's DCC
  // files, under DCC's caps rather than the uploader's.
  describe('a DCC file to send', () => {
    let dccDir: string;
    let caps: typeof import('../db/userCapabilities.js');
    let storage: typeof import('../db/dccStorageLimits.js');

    beforeAll(async () => {
      caps = await import('../db/userCapabilities.js');
      storage = await import('../db/dccStorageLimits.js');
      const os = await import('node:os');
      const path = await import('node:path');
      dccDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-dcc-'));
    });

    afterAll(() => fs.rmSync(dccDir, { recursive: true, force: true }));

    beforeEach(() => {
      process.env.LURKER_DCC_ENABLED = '1';
      process.env.LURKER_DCC_DIR = dccDir;
      caps.setUserCapability(aliceId, caps.CAPABILITY_DCC_SEND, true);
    });

    afterEach(() => {
      delete process.env.LURKER_DCC_ENABLED;
      delete process.env.LURKER_DCC_DIR;
      delete process.env.LURKER_DCC_MAX_FILE_MB;
      caps.setUserCapability(aliceId, caps.CAPABILITY_DCC_SEND, false);
      storage.setDccStorageLimit(aliceId, null);
    });

    it('keeps the file in the account’s DCC folder', async () => {
      const bytes = text(3);
      const { id } = (await open({ purpose: 'dcc-send', size: bytes.length, filename: 'a b.txt' }))
        .body;
      await sendAll(id, bytes);
      const res = await alice.post(`/api/upload-sessions/${id}/complete`).send({});
      expect(res.status).toBe(200);
      expect(res.body.file).toMatchObject({
        name: 'a b.txt',
        size: bytes.length,
        origin: 'uploaded',
        peer_nick: null,
      });
      const kept = `${dccDir}/sess-alice/a b.txt`;
      expect(fs.readFileSync(kept).equals(bytes)).toBe(true);
      expect(fs.existsSync(sessions.uploadSessionPath(id))).toBe(false);
      // A second file of the same name doesn't overwrite the first.
      const again = (await open({ purpose: 'dcc-send', size: bytes.length, filename: 'a b.txt' }))
        .body.id;
      await sendAll(again, bytes);
      const second = await alice.post(`/api/upload-sessions/${again}/complete`).send({});
      expect(second.body.file.name).toBe('a b (1).txt');
    });

    it('needs the send grant', async () => {
      const res = await open({ purpose: 'dcc-send', size: 10, filename: 'x' }, bob);
      expect(res.status).toBe(403);
    });

    it('is capped by LURKER_DCC_MAX_FILE_MB, not the upload cap', async () => {
      // Over the uploader's 200 MB ceiling, and only declared: no bytes sent.
      const big = await open({ purpose: 'dcc-send', size: 300 * 1024 * 1024, filename: 'big' });
      expect(big.status).toBe(201);
      await alice.delete(`/api/upload-sessions/${big.body.id}`);
      process.env.LURKER_DCC_MAX_FILE_MB = '1';
      const over = await open({ purpose: 'dcc-send', size: 1024 * 1024 + 1, filename: 'big' });
      expect(over.status).toBe(413);
    });

    // Two uploads that each fit alone must not together pass the limit.
    it('counts uploads still under way against the storage limit', async () => {
      storage.setDccStorageLimit(aliceId, 1000);
      const first = await open({ purpose: 'dcc-send', size: 600, filename: 'one' });
      expect(first.status).toBe(201);
      const second = await open({ purpose: 'dcc-send', size: 600, filename: 'two' });
      expect(second.status).toBe(413);
      expect(second.body.code).toBe('dcc_storage_limit');
      await alice.delete(`/api/upload-sessions/${first.body.id}`);
      expect((await open({ purpose: 'dcc-send', size: 600, filename: 'two' })).status).toBe(201);
    });

    // A closed tab leaves its session for the day-long sweep; it stops holding
    // space once it has gone an hour without a chunk.
    it('stops counting an upload that has gone idle', async () => {
      storage.setDccStorageLimit(aliceId, 1000);
      const { default: db } = await import('../db/index.js');
      db.prepare(`DELETE FROM upload_sessions WHERE purpose = 'dcc-send'`).run();
      const idle = await open({ purpose: 'dcc-send', size: 600, filename: 'idle' });
      expect((await open({ purpose: 'dcc-send', size: 600, filename: 'b' })).status).toBe(413);
      db.prepare(
        `UPDATE upload_sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours') WHERE id = ?`,
      ).run(idle.body.id);
      expect((await open({ purpose: 'dcc-send', size: 600, filename: 'b' })).status).toBe(201);
      // Having let go of its space, the idle one must fit again to carry on.
      const res = await put(idle.body.id, 0, Buffer.alloc(16));
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('dcc_storage_limit');
    });

    it('is refused without a DCC folder configured', async () => {
      delete process.env.LURKER_DCC_DIR;
      expect((await open({ purpose: 'dcc-send', size: 10, filename: 'x' })).status).toBe(503);
    });
  });
});

describe('an account held off the uploaders', () => {
  let heldAgent: LurkerTestAgent;
  let heldId: number;

  beforeAll(async () => {
    const { createUser, setUserRestrictions } = await import('../db/users.js');
    heldId = createUser('sess-held').id;
    setUserRestrictions(heldId, { networks: null, uploads: false });
    heldAgent = await createAuthedAgent(app, heldId);
  });

  it('cannot open an upload or avatar session', async () => {
    for (const purpose of ['upload', 'avatar']) {
      const res = await open(
        { purpose, size: 4, filename: 'a.txt', mime: 'text/plain' },
        heldAgent,
      );
      expect([purpose, res.status]).toStrictEqual([purpose, 403]);
      expect(res.body.error).toBe('uploads are not enabled for this account');
    }
  });

  // An import stays on this disk; it is not the CDN and is not withheld.
  it('can still open an import session', async () => {
    const res = await open({ purpose: 'import', size: 4, filename: 'a.zip' }, heldAgent);
    expect(res.status).toBe(201);
    await heldAgent.delete(`/api/upload-sessions/${res.body.id}`);
  });

  // The restriction landed while the chunks were in flight.
  it('refuses to complete a session opened before the restriction', async () => {
    const { setUserRestrictions } = await import('../db/users.js');
    setUserRestrictions(heldId, { networks: null, uploads: true });
    const file = text(1);
    const created = await open(
      { purpose: 'upload', size: file.length, filename: 'late.txt', mime: 'text/plain' },
      heldAgent,
    );
    expect(created.status).toBe(201);
    for (let at = 0; at < file.length; at += CHUNK) {
      await put(created.body.id, at, file.subarray(at, at + CHUNK), heldAgent);
    }
    setUserRestrictions(heldId, { networks: null, uploads: false });
    const done = await heldAgent.post(`/api/upload-sessions/${created.body.id}/complete`).send({});
    expect(done.status).toBe(403);
  });
});
