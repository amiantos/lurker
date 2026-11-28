// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Upload sessions (#650) below the router: a chunk cut off partway, two
// writers at once, and the sweep. The router's own tests are in
// routes/uploadSessions.test.ts.

import '../test-utils/isolateDb.js';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The free-disk floor, watched: what each check asked for, and the answer.
const disk = vi.hoisted(() => ({ full: false, asked: [] as number[] }));
vi.mock('../utils/diskSpace.js', () => ({
  FREE_DISK_FLOOR_BYTES: 1024 ** 3,
  hasFreeSpaceFor: (_dir: string, bytes: number) => {
    disk.asked.push(bytes);
    return !disk.full;
  },
}));

import db from '../db/index.js';
import { createUser } from '../db/users.js';
import { until } from '../test-utils/until.js';
import { setUploadChunkBytesForTests } from './uploadLimits.js';
import {
  abortUploadSession,
  appendUploadChunk,
  createUploadSession,
  finishUploadSession,
  sweepUploadSessions,
  UPLOAD_SESSION_DIR,
  UPLOAD_SESSION_IDLE_MS,
  uploadSessionOffset,
  uploadSessionPath,
  uploadSessionStatus,
} from './uploadSessions.js';

let user: { id: number; isAdmin: boolean };
beforeAll(() => {
  user = { id: createUser('sess-svc').id, isAdmin: false };
  setUploadChunkBytesForTests(64);
});
afterAll(() => setUploadChunkBytesForTests(null));

const open = (size = 64) =>
  createUploadSession(user, { purpose: 'import', size, filename: 'a.lurk' }).id;

describe('a chunk', () => {
  it('cut off partway keeps what arrived, and the offset says so', async () => {
    const id = open();
    const body = new PassThrough();
    const pending = appendUploadChunk(user.id, id, '0', 64, body);
    body.write(Buffer.from('hello'));
    // On disk first: cut off before the write landed, the offset is 0 (#1474).
    await until(() => uploadSessionOffset(id) === 5, 5000, 'hello on disk');
    body.destroy(new Error('socket hang up'));
    await expect(pending).rejects.toMatchObject({
      status: 400,
      extra: { code: 'interrupted', offset: 5 },
    });
    expect(fs.readFileSync(uploadSessionPath(id), 'utf8')).toBe('hello');
    expect(uploadSessionStatus(user.id, id).offset).toBe(5);
  });

  it('is refused while another is still being written to the same session', async () => {
    const id = open();
    const first = new PassThrough();
    const pending = appendUploadChunk(user.id, id, '0', 10, first);
    first.write(Buffer.from('12345'));
    await until(() => uploadSessionOffset(id) === 5, 5000, 'the first chunk on disk');
    await expect(
      appendUploadChunk(user.id, id, '0', 5, PassThrough.from([Buffer.from('xxxxx')])),
    ).rejects.toMatchObject({ status: 409, extra: { code: 'session_busy' } });
    first.end(Buffer.from('67890'));
    await expect(pending).resolves.toEqual({ offset: 10 });
    expect(fs.readFileSync(uploadSessionPath(id), 'utf8')).toBe('1234567890');
  });

  // A complete whose answer was lost may still be handing the file on.
  it('keeps its session from being dropped while it is written', async () => {
    const id = open();
    const body = new PassThrough();
    const pending = appendUploadChunk(user.id, id, '0', 4, body);
    expect(() => abortUploadSession(user.id, id)).toThrow(/busy/);
    body.end(Buffer.from('abcd'));
    await pending;
    abortUploadSession(user.id, id);
    expect(() => uploadSessionStatus(user.id, id)).toThrow(/no such upload session/);
  });

  // No Content-Length to check up front: the bytes past the limit are the tell.
  it('that runs past the limit with no declared length leaves the file as it was', async () => {
    const id = open(100);
    await appendUploadChunk(user.id, id, '0', null, PassThrough.from([Buffer.alloc(10, 97)]));
    // 60 bytes land before the 10 that cross the 64.
    const body = new PassThrough();
    const pending = appendUploadChunk(user.id, id, '10', null, body);
    body.write(Buffer.alloc(60, 98));
    await until(() => uploadSessionOffset(id) === 70, 5000, 'the 60 bytes on disk');
    body.end(Buffer.alloc(10, 98));
    await expect(pending).rejects.toMatchObject({
      status: 413,
      extra: { code: 'chunk_too_large', offset: 10 },
    });
    expect(uploadSessionOffset(id)).toBe(10);
  });

  it('declared larger than the limit is refused before a byte is read', async () => {
    const id = open(100);
    const unread = new PassThrough(); // never ends: only the declared length can refuse it
    await expect(appendUploadChunk(user.id, id, '0', 65, unread)).rejects.toMatchObject({
      status: 413,
      extra: { code: 'chunk_too_large', offset: 0 },
    });
  });
});

describe('the disk', () => {
  // Ten sessions that each fit alone could together fill it.
  it('must hold a new file and everything the open sessions will still write', async () => {
    const half = open(64);
    await appendUploadChunk(user.id, half, '0', 10, PassThrough.from([Buffer.alloc(10)]));
    const still = (
      db.prepare(`SELECT id, size FROM upload_sessions WHERE state = 'open'`).all() as {
        id: string;
        size: number;
      }[]
    ).reduce((n, r) => n + r.size - uploadSessionOffset(r.id), 0);
    open(50);
    expect(disk.asked.at(-1)).toBe(50 + still);
  });

  it('refuses a chunk once something else has taken the space', async () => {
    const id = open(64);
    disk.full = true;
    try {
      await expect(
        appendUploadChunk(user.id, id, '0', 4, PassThrough.from([Buffer.from('abcd')])),
      ).rejects.toMatchObject({ status: 507, extra: { offset: 0 } });
      expect(uploadSessionOffset(id)).toBe(0);
    } finally {
      disk.full = false;
    }
  });

  // The client is still there; telling it its chunk was cut off would be a lie
  // it treats as final.
  it('reports its own write failing as the server’s fault, not a cut-off chunk', async () => {
    const id = open(64);
    fs.chmodSync(uploadSessionPath(id), 0o400);
    try {
      await expect(
        appendUploadChunk(user.id, id, '0', 4, PassThrough.from([Buffer.from('abcd')])),
      ).rejects.toMatchObject({ status: 500, extra: { offset: 0 } });
    } finally {
      fs.chmodSync(uploadSessionPath(id), 0o600);
    }
  });
});

describe('finishing', () => {
  const full = async (size = 4) => {
    const id = open(size);
    await appendUploadChunk(user.id, id, '0', size, PassThrough.from([Buffer.alloc(size, 97)]));
    return id;
  };

  it('is processing until the file is handed on, and can be neither dropped nor finished twice', async () => {
    const id = await full();
    let release!: () => void;
    const pending = finishUploadSession(user.id, id, async () => {
      await new Promise<void>((r) => (release = r));
      return { status: 200, body: { ok: true } };
    });
    expect(uploadSessionStatus(user.id, id).state).toBe('processing');
    expect(() => abortUploadSession(user.id, id)).toThrow(/being processed/);
    await expect(
      finishUploadSession(user.id, id, async () => ({ status: 200, body: {} })),
    ).rejects.toMatchObject({ status: 409, extra: { code: 'processing' } });
    release();
    await expect(pending).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(uploadSessionStatus(user.id, id)).toMatchObject({
      state: 'done',
      result: { status: 200, body: { ok: true } },
    });
  });

  it('keeps a 500 as the answer when handing the file on throws', async () => {
    const id = await full();
    await expect(
      finishUploadSession(user.id, id, async () => {
        throw new Error('driver exploded');
      }),
    ).rejects.toThrow('driver exploded');
    expect(uploadSessionStatus(user.id, id).result?.status).toBe(500);
  });

  // A restart mid-complete, or an answer the DB wouldn't take: nothing is
  // working on it, and a client polling must not wait forever.
  it('reads as done with a 500 once processing with nothing working on it', async () => {
    const id = await full();
    db.prepare(`UPDATE upload_sessions SET state = 'processing' WHERE id = ?`).run(id);
    const status = uploadSessionStatus(user.id, id);
    expect(status.state).toBe('done');
    expect(status.result?.status).toBe(500);
    await expect(
      finishUploadSession(user.id, id, async () => ({ status: 200, body: {} })),
    ).resolves.toMatchObject({ status: 500 });
    abortUploadSession(user.id, id);
  });
});

describe('sweepUploadSessions', () => {
  it('removes a session a day idle and an unowned file as old, and nothing newer', async () => {
    const idle = open();
    const fresh = open();
    const old = new Date(Date.now() - UPLOAD_SESSION_IDLE_MS - 60_000);
    db.prepare('UPDATE upload_sessions SET updated_at = ? WHERE id = ?').run(
      old.toISOString(),
      idle,
    );
    const orphan = path.join(UPLOAD_SESSION_DIR, 'orphan-from-a-crash');
    const newOrphan = path.join(UPLOAD_SESSION_DIR, 'orphan-just-now');
    fs.writeFileSync(orphan, 'x');
    fs.writeFileSync(newOrphan, 'x');
    fs.utimesSync(orphan, old, old);
    // A live session's file is its own however old, never an orphan.
    fs.utimesSync(uploadSessionPath(fresh), old, old);

    await sweepUploadSessions();
    // A session's unlink is fire-and-forget.
    await until(() => !fs.existsSync(uploadSessionPath(idle)), 5000, 'the idle file gone');

    expect(() => uploadSessionStatus(user.id, idle)).toThrow(/no such upload session/);
    expect(fs.existsSync(uploadSessionPath(idle))).toBe(false);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(uploadSessionStatus(user.id, fresh).offset).toBe(0);
    expect(fs.existsSync(uploadSessionPath(fresh))).toBe(true);
    expect(fs.existsSync(newOrphan)).toBe(true);
    fs.rmSync(newOrphan);
  });

  it('counts a chunk as activity', async () => {
    const id = open();
    const old = new Date(Date.now() - UPLOAD_SESSION_IDLE_MS - 60_000).toISOString();
    db.prepare('UPDATE upload_sessions SET updated_at = ? WHERE id = ?').run(old, id);
    await appendUploadChunk(user.id, id, '0', 3, PassThrough.from([Buffer.from('abc')]));
    await sweepUploadSessions();
    expect(uploadSessionStatus(user.id, id).offset).toBe(3);
  });
});
