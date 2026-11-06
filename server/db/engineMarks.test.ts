// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine catch-up mark (#1068): one row per network and socket, written in
// the same transaction as the message row it counts, never lowered.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-marks-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let marks: typeof import('./engineMarks.js');
let messages: typeof import('./messages.js');
let networks: typeof import('./networks.js');
let userId: number;

const network = () =>
  networks.createNetwork(userId, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'me' })!.id;

beforeAll(async () => {
  const { createUser } = await import('./users.js');
  networks = await import('./networks.js');
  marks = await import('./engineMarks.js');
  messages = await import('./messages.js');
  userId = createUser('marks-user').id;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('engine catch-up mark', () => {
  it('is absent until written, then reads back under its socket only', () => {
    const id = network();
    expect(marks.getEngineMark(id, 'sock-a')).toBeNull();
    marks.setEngineMark(id, 'sock-a', 7);
    expect(marks.getEngineMark(id, 'sock-a')).toBe(7);
    expect(marks.getEngineMark(id, 'sock-b')).toBeNull();
  });

  it('only ever rises for a socket: an older process’s late write cannot lower it', () => {
    const id = network();
    marks.setEngineMark(id, 'sock-a', 40);
    marks.setEngineMark(id, 'sock-a', 25);
    expect(marks.getEngineMark(id, 'sock-a')).toBe(40);
    marks.setEngineMark(id, 'sock-a', 41);
    expect(marks.getEngineMark(id, 'sock-a')).toBe(41);
  });

  it('a retired socket’s late write lands in its own row, never the live socket’s', () => {
    // A predecessor outliving its claim: it wrote under A, the successor
    // re-dialed B, and A's last batch lands after B's first.
    const id = network();
    marks.setEngineMark(id, 'sock-a', 900);
    marks.setEngineMark(id, 'sock-b', 50);
    marks.setEngineMark(id, 'sock-a', 901);
    expect(marks.getEngineMark(id, 'sock-b')).toBe(50);
    // The next attach on B prunes what A left; all of it on a fresh dial.
    marks.pruneEngineMarks(id, 'sock-b');
    expect(marks.getEngineMark(id, 'sock-a')).toBeNull();
    expect(marks.getEngineMark(id, 'sock-b')).toBe(50);
    marks.pruneEngineMarks(id, null);
    expect(marks.getEngineMark(id, 'sock-b')).toBeNull();
  });

  it('storeUnderMark stores the row and the mark together, or neither', () => {
    const id = network();
    const say = (text: string) =>
      messages.insertMessage({
        networkId: id,
        target: '#c',
        time: new Date().toISOString(),
        type: 'message',
        nick: 'peer',
        text,
        self: false,
      });
    const count = () => messages.countOlder(id, '#c', Number.MAX_SAFE_INTEGER);
    // A row: the mark rises with it.
    expect(marks.storeUnderMark(id, 'sock-a', 2, () => say('two'))).toBeTruthy();
    expect(marks.getEngineMark(id, 'sock-a')).toBe(2);
    expect(count()).toBe(1);
    // An insert that throws takes nothing with it, and the mark stays: the
    // line is unacked and comes again.
    expect(() =>
      marks.storeUnderMark(id, 'sock-a', 3, () => {
        say('three');
        throw new Error('insert failed');
      }),
    ).toThrow('insert failed');
    expect(marks.getEngineMark(id, 'sock-a')).toBe(2);
    expect(count()).toBe(1);
    // The mark reached the seq meanwhile (a predecessor stored the line):
    // nothing is inserted, and the caller is told.
    marks.setEngineMark(id, 'sock-a', 5);
    expect(marks.storeUnderMark(id, 'sock-a', 5, () => say('five'))).toBeNull();
    expect(count()).toBe(1);
    // Another socket's mark is not this socket's.
    expect(marks.storeUnderMark(id, 'sock-b', 1, () => say('one on b'))).toBeTruthy();
    expect(count()).toBe(2);
    // A batch: several rows under one seq, from the process that stored the
    // first. Each is stored beside the mark it raised; only a mark PAST the
    // seq (a later line, stored by whoever) refuses one.
    expect(marks.storeUnderMark(id, 'sock-b', 2, () => say('batch 1'))).toBeTruthy();
    expect(marks.storeUnderMark(id, 'sock-b', 2, () => say('batch 2'), true)).toBeTruthy();
    expect(marks.storeUnderMark(id, 'sock-b', 2, () => say('batch 3'), true)).toBeTruthy();
    expect(marks.getEngineMark(id, 'sock-b')).toBe(2);
    expect(count()).toBe(5);
    marks.setEngineMark(id, 'sock-b', 3);
    expect(marks.storeUnderMark(id, 'sock-b', 2, () => say('batch late'), true)).toBeNull();
    // Without the claim, the same seq is a predecessor's line, as before.
    expect(marks.storeUnderMark(id, 'sock-b', 2, () => say('batch stranger'))).toBeNull();
    expect(count()).toBe(5);
  });

  it('goes with its network', () => {
    const id = network();
    marks.setEngineMark(id, 'sock-a', 1);
    networks.deleteNetwork(id, userId);
    expect(marks.getEngineMark(id, 'sock-a')).toBeNull();
  });
});
