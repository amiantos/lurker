// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runFserveCommand, displayPath, type FserveState } from './fserveCommands.js';

// A small archive tree on disk:
//   root/
//     readme.txt        (12 bytes)
//     music/
//       song.mp3        (2048 bytes)
//     empty/
let root: string;
let outside: string; // a sibling file OUTSIDE the root, for traversal tests

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fserve-root-'));
  fs.writeFileSync(path.join(root, 'readme.txt'), 'hello world!');
  fs.mkdirSync(path.join(root, 'music'));
  fs.writeFileSync(path.join(root, 'music', 'song.mp3'), Buffer.alloc(2048));
  fs.mkdirSync(path.join(root, 'empty'));
  // A secret file next to (above) the root the sandbox must never reach.
  outside = path.join(path.dirname(root), 'SECRET.txt');
  fs.writeFileSync(outside, 'do not leak');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

const atRoot = (): FserveState => ({ root, cwd: root });

describe('displayPath', () => {
  it('shows / at root and /sub below', () => {
    expect(displayPath(root, root)).toBe('/');
    expect(displayPath(root, path.join(root, 'music'))).toBe('/music');
  });
});

describe('runFserveCommand — listing + help', () => {
  it('dir lists directories then files with sizes', () => {
    const r = runFserveCommand(atRoot(), 'dir');
    expect(r.lines[0]).toBe('Directory /:');
    expect(r.lines.some((l) => l.includes('[DIR]  empty/'))).toBe(true);
    expect(r.lines.some((l) => l.includes('[DIR]  music/'))).toBe(true);
    expect(r.lines.some((l) => l.endsWith('readme.txt') && l.includes('12 B'))).toBe(true);
  });

  it('ls is an alias for dir', () => {
    expect(runFserveCommand(atRoot(), 'ls').lines[0]).toBe('Directory /:');
  });

  it('reports an empty directory', () => {
    const r = runFserveCommand({ root, cwd: path.join(root, 'empty') }, 'dir');
    expect(r.lines).toContain('  (empty)');
  });

  it('help + quit', () => {
    expect(runFserveCommand(atRoot(), 'help').lines[0]).toBe('Commands:');
    expect(runFserveCommand(atRoot(), 'quit')).toMatchObject({ close: true });
  });

  it('unknown command is rejected without action', () => {
    const r = runFserveCommand(atRoot(), 'rm -rf /');
    expect(r.lines[0]).toMatch(/Unknown command/);
    expect(r.sendPath).toBeUndefined();
    expect(r.newCwd).toBeUndefined();
  });
});

describe('runFserveCommand — cd navigation', () => {
  it('cd into a subdir updates cwd', () => {
    const r = runFserveCommand(atRoot(), 'cd music');
    expect(r.newCwd).toBe(path.join(root, 'music'));
    expect(r.lines[0]).toBe('Now in /music');
  });

  it('cd .. goes up, cd / returns to root', () => {
    const inMusic: FserveState = { root, cwd: path.join(root, 'music') };
    expect(runFserveCommand(inMusic, 'cd ..').newCwd).toBe(root);
    expect(runFserveCommand(inMusic, 'cd /').newCwd).toBe(root);
  });

  it('cd to a nonexistent dir is a clean error', () => {
    const r = runFserveCommand(atRoot(), 'cd nope');
    expect(r.lines[0]).toMatch(/No such directory/);
    expect(r.newCwd).toBeUndefined();
  });

  it('cd onto a file is rejected', () => {
    expect(runFserveCommand(atRoot(), 'cd readme.txt').lines[0]).toMatch(/Not a directory/);
  });
});

describe('runFserveCommand — get', () => {
  it('get a file returns its absolute path to send', () => {
    const r = runFserveCommand(atRoot(), 'get readme.txt');
    expect(r.sendPath).toBe(path.join(root, 'readme.txt'));
    expect(r.lines[0]).toMatch(/Sending "readme\.txt" \(12 B\)/);
  });

  it('get a file in a subdir via cwd', () => {
    const r = runFserveCommand({ root, cwd: path.join(root, 'music') }, 'get song.mp3');
    expect(r.sendPath).toBe(path.join(root, 'music', 'song.mp3'));
  });

  it('get a directory is refused', () => {
    const r = runFserveCommand(atRoot(), 'get music');
    expect(r.sendPath).toBeUndefined();
    expect(r.lines[0]).toMatch(/is a directory/);
  });

  it('get a nonexistent file is a clean error', () => {
    expect(runFserveCommand(atRoot(), 'get ghost.bin').lines[0]).toMatch(/No such file/);
  });
});

describe('runFserveCommand — SANDBOX (path traversal must never escape root)', () => {
  const traversals = [
    'cd ..',
    'cd ../..',
    'cd ../../etc',
    'cd /..',
    'get ../SECRET.txt',
    'get ../../SECRET.txt',
    'get /../SECRET.txt',
    'cd ....//....//',
  ];

  it('cd .. AT ROOT stays at root (can never go above the archive)', () => {
    // Resolving root/.. is contained back to root by the sandbox, so it's a
    // no-op "Now in /", never the server directory above.
    const r = runFserveCommand(atRoot(), 'cd ..');
    expect(r.newCwd === undefined || r.newCwd === root).toBe(true);
  });

  it('refuses every traversal attempt and never yields a path outside root', () => {
    for (const cmd of traversals) {
      const r = runFserveCommand(atRoot(), cmd);
      // No escape: any sendPath/newCwd is either absent or within root, and the
      // outside secret is never the target. Fold to unconditional assertions.
      const sendWithin = r.sendPath === undefined || r.sendPath.startsWith(root + path.sep);
      const cwdWithin =
        r.newCwd === undefined || r.newCwd === root || r.newCwd.startsWith(root + path.sep);
      expect({ cmd, sendWithin, cwdWithin, leaked: r.sendPath === outside }).toEqual({
        cmd,
        sendWithin: true,
        cwdWithin: true,
        leaked: false,
      });
    }
  });

  it('an absolute get of the outside secret is denied', () => {
    const r = runFserveCommand(atRoot(), `get ${outside}`);
    expect(r.sendPath).toBeUndefined();
    expect(r.lines[0]).toMatch(/Access denied|No such file/);
  });
});
