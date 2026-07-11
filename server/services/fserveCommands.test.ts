// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  runFserveCommand,
  displayPath,
  searchArchive,
  FSERVE_CONTROL_COMMANDS,
  type FserveState,
} from './fserveCommands.js';

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
  it('dir lists directories (Nd) then files (NF) with sizes', () => {
    const r = runFserveCommand(atRoot(), 'dir');
    expect(r.lines[0]).toBe('Directory /:');
    // At root there is no "0d ../" line.
    expect(r.lines.some((l) => l.includes('0d  ../'))).toBe(false);
    expect(r.lines.some((l) => l.includes('1d  empty/'))).toBe(true);
    expect(r.lines.some((l) => l.includes('2d  music/'))).toBe(true);
    expect(
      r.lines.some((l) => l.includes('1F') && l.endsWith('readme.txt') && l.includes('12 B')),
    ).toBe(true);
    expect(r.lines[r.lines.length - 1]).toBe('End of list — 2 dir(s), 1 file(s).');
  });

  it('a subdirectory listing offers 0d to go up', () => {
    const r = runFserveCommand({ root, cwd: path.join(root, 'music') }, 'dir');
    expect(r.lines.some((l) => l.includes('0d  ../'))).toBe(true);
    expect(r.lines.some((l) => l.includes('1F') && l.endsWith('song.mp3'))).toBe(true);
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

describe('runFserveCommand — number-letter navigation', () => {
  it('1d enters the first directory (empty), 2d the second (music)', () => {
    expect(runFserveCommand(atRoot(), '1d').newCwd).toBe(path.join(root, 'empty'));
    expect(runFserveCommand(atRoot(), '2d').newCwd).toBe(path.join(root, 'music'));
  });

  it('0d goes up one level', () => {
    const inMusic: FserveState = { root, cwd: path.join(root, 'music') };
    expect(runFserveCommand(inMusic, '0d').newCwd).toBe(root);
  });

  it('1F gets the first file', () => {
    const r = runFserveCommand(atRoot(), '1F');
    expect(r.sendPath).toBe(path.join(root, 'readme.txt'));
  });

  it('an out-of-range index is a clean error, no action', () => {
    const r = runFserveCommand(atRoot(), '9F');
    expect(r.lines[0]).toMatch(/No file 9F here/);
    expect(r.sendPath).toBeUndefined();
  });
});

describe('runFserveCommand — get (hands a path to the queue, no premature line)', () => {
  it('get a file returns its absolute path and no status line', () => {
    const r = runFserveCommand(atRoot(), 'get readme.txt');
    expect(r.sendPath).toBe(path.join(root, 'readme.txt'));
    expect(r.lines).toEqual([]); // the caller/queue emits the real status
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

describe('runFserveCommand — control commands are delegated', () => {
  it('recognises the stateful command set and returns a control marker', () => {
    for (const c of ['queues', 'sends', 'stats', 'who', 'clr_queue', 'clr_queues']) {
      const r = runFserveCommand(atRoot(), c);
      expect(r.control?.name).toBe(c);
      expect(r.sendPath).toBeUndefined();
      expect(r.newCwd).toBeUndefined();
    }
  });

  it('normalises "queue" to "queues" and carries the arg', () => {
    expect(runFserveCommand(atRoot(), 'queue').control?.name).toBe('queues');
    const r = runFserveCommand(atRoot(), 'clr_queue please');
    expect(r.control).toEqual({ name: 'clr_queue', arg: 'please' });
  });

  it('exports the canonical control command set', () => {
    expect(FSERVE_CONTROL_COMMANDS.has('stats')).toBe(true);
    expect(FSERVE_CONTROL_COMMANDS.has('get')).toBe(false);
  });
});

describe('searchArchive (@find backend)', () => {
  it('matches files by name, returning archive-relative paths + sizes', () => {
    const r = searchArchive(root, 'song');
    expect(r.results).toEqual([{ path: '/music/song.mp3', size: 2048 }]);
    expect(r.truncated).toBe(false);
  });

  it('requires ALL whitespace terms to appear in the path', () => {
    expect(searchArchive(root, 'music song').results).toHaveLength(1);
    expect(searchArchive(root, 'music nope').results).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    expect(searchArchive(root, 'README').results[0].path).toBe('/readme.txt');
  });

  it('empty query yields nothing', () => {
    expect(searchArchive(root, '   ').results).toHaveLength(0);
  });

  it('honours maxResults and flags truncation', () => {
    // Both files contain a common substring via their extension-less names? Use a
    // term present in more than one path: the archive root separator "/" — every
    // file path contains it, so all match; cap at 1.
    const r = searchArchive(root, '.', { maxResults: 1 });
    expect(r.results).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it('stops when the time budget is exhausted (never escapes root)', () => {
    // now() jumps past the budget immediately → the walk halts, no leak.
    let t = 0;
    const r = searchArchive(root, 'song', { budgetMs: 5, now: () => (t += 1000) });
    expect(r.results.every((h) => h.path.startsWith('/'))).toBe(true);
  });
});

describe('visibility filter (hidden files / allowed extensions)', () => {
  let froot: string;
  beforeAll(() => {
    froot = fs.mkdtempSync(path.join(os.tmpdir(), 'fserve-filter-'));
    fs.writeFileSync(path.join(froot, 'song.mp3'), 'a');
    fs.writeFileSync(path.join(froot, 'notes.txt'), 'b');
    fs.writeFileSync(path.join(froot, '.secret'), 'c');
    fs.mkdirSync(path.join(froot, '.hidden'));
    fs.mkdirSync(path.join(froot, 'music'));
  });
  afterAll(() => fs.rmSync(froot, { recursive: true, force: true }));

  const withFilter = (hideDotfiles: boolean, allowedExts: string[]): FserveState => ({
    root: froot,
    cwd: froot,
    filter: { hideDotfiles, allowedExts },
  });

  it('hides dotfiles + dot-dirs from dir when hideDotfiles is on', () => {
    const r = runFserveCommand(withFilter(true, []), 'dir');
    const joined = r.lines.join('\n');
    expect(joined).not.toContain('.secret');
    expect(joined).not.toContain('.hidden');
    expect(joined).toContain('music/');
    expect(joined).toContain('song.mp3');
  });

  it('shows dotfiles when hideDotfiles is off', () => {
    const joined = runFserveCommand(withFilter(false, []), 'dir').lines.join('\n');
    expect(joined).toContain('.secret');
    expect(joined).toContain('.hidden');
  });

  it('extension allow-list restricts files but not directories', () => {
    const joined = runFserveCommand(withFilter(true, ['mp3']), 'dir').lines.join('\n');
    expect(joined).toContain('song.mp3');
    expect(joined).not.toContain('notes.txt');
    expect(joined).toContain('music/'); // dirs always browsable
  });

  it('get of a filtered-out file is refused as "no such file"', () => {
    expect(runFserveCommand(withFilter(true, ['mp3']), 'get notes.txt').lines[0]).toMatch(
      /No such file/,
    );
    expect(runFserveCommand(withFilter(true, []), 'get .secret').lines[0]).toMatch(/No such file/);
    // an allowed file still sends
    expect(runFserveCommand(withFilter(true, ['mp3']), 'get song.mp3').sendPath).toBe(
      path.join(froot, 'song.mp3'),
    );
  });

  it('cd into a hidden dir is refused when dotfiles are filtered', () => {
    expect(runFserveCommand(withFilter(true, []), 'cd .hidden').lines[0]).toMatch(
      /No such directory/,
    );
    expect(runFserveCommand(withFilter(false, []), 'cd .hidden').newCwd).toBe(
      path.join(froot, '.hidden'),
    );
  });

  it('searchArchive honours the filter (hidden + extension)', () => {
    const all = searchArchive(froot, '.', { filter: { hideDotfiles: false, allowedExts: [] } });
    expect(all.results.some((h) => h.path === '/.secret')).toBe(true);
    const filtered = searchArchive(froot, '.', {
      filter: { hideDotfiles: true, allowedExts: ['mp3'] },
    });
    const paths = filtered.results.map((h) => h.path);
    expect(paths).toContain('/song.mp3');
    expect(paths).not.toContain('/notes.txt');
    expect(paths).not.toContain('/.secret');
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
