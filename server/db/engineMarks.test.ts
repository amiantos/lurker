// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine catch-up mark (#1068): one row per network, honoured only beside
// the socket it was written on, and never lowered for that socket.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-marks-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let marks: typeof import('./engineMarks.js');
let networks: typeof import('./networks.js');
let userId: number;

const network = () =>
  networks.createNetwork(userId, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'me' })!.id;

beforeAll(async () => {
  const { createUser } = await import('./users.js');
  networks = await import('./networks.js');
  marks = await import('./engineMarks.js');
  userId = createUser('marks-user').id;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('engine catch-up mark', () => {
  it('is absent until written, then reads back', () => {
    const id = network();
    expect(marks.getEngineMark(id)).toBeNull();
    marks.setEngineMark(id, 'sock-a', 7);
    expect(marks.getEngineMark(id)).toEqual({ socket: 'sock-a', seq: 7 });
  });

  it('only ever rises for the same socket: an older process’s late write cannot lower it', () => {
    const id = network();
    marks.setEngineMark(id, 'sock-a', 40);
    marks.setEngineMark(id, 'sock-a', 25);
    expect(marks.getEngineMark(id)).toEqual({ socket: 'sock-a', seq: 40 });
    marks.setEngineMark(id, 'sock-a', 41);
    expect(marks.getEngineMark(id)).toEqual({ socket: 'sock-a', seq: 41 });
  });

  it('a different socket replaces the row whatever its seq: seqs restart on every dial', () => {
    const id = network();
    marks.setEngineMark(id, 'sock-a', 900);
    marks.setEngineMark(id, 'sock-b', 3);
    expect(marks.getEngineMark(id)).toEqual({ socket: 'sock-b', seq: 3 });
  });

  it('goes with its network', () => {
    const id = network();
    marks.setEngineMark(id, 'sock-a', 1);
    networks.deleteNetwork(id, userId);
    expect(marks.getEngineMark(id)).toBeNull();
  });
});
