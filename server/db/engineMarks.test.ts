// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine catch-up mark (#1068): one row per network and socket, written in
// the line's own transaction, only when the line wrote a row, never lowered.

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

  it('deliverUnderMark moves the mark only for a line that wrote a row, with the row', () => {
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
    // No row, no mark: a PING, a 353.
    marks.deliverUnderMark(id, 'sock-a', 1, () => false);
    expect(marks.getEngineMark(id, 'sock-a')).toBeNull();
    // A row: the mark rises with it.
    marks.deliverUnderMark(id, 'sock-a', 2, () => {
      say('two');
      return true;
    });
    expect(marks.getEngineMark(id, 'sock-a')).toBe(2);
    expect(count()).toBe(1);
    // A handler that throws takes the line's row back with it, and the mark
    // stays where it was: the line is unacked and comes again.
    expect(() =>
      marks.deliverUnderMark(id, 'sock-a', 3, () => {
        say('three');
        throw new Error('handler threw');
      }),
    ).toThrow('handler threw');
    expect(marks.getEngineMark(id, 'sock-a')).toBe(2);
    expect(count()).toBe(1);
  });

  it('goes with its network', () => {
    const id = network();
    marks.setEngineMark(id, 'sock-a', 1);
    networks.deleteNetwork(id, userId);
    expect(marks.getEngineMark(id, 'sock-a')).toBeNull();
  });
});
