// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as local from './local.js';

let dir: string;
const prevEnv = process.env.LOCAL_UPLOADS_DIR;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-local-'));
  process.env.LOCAL_UPLOADS_DIR = dir;
});

afterAll(() => {
  if (prevEnv == null) delete process.env.LOCAL_UPLOADS_DIR;
  else process.env.LOCAL_UPLOADS_DIR = prevEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('local driver', () => {
  it('declares self-host, deletable, key-minting capabilities', () => {
    expect(local.capabilities.storesRemotely).toBe(false);
    expect(local.capabilities.supportsDelete).toBe(true);
    expect(local.capabilities.mintsKeys).toBe(true);
    expect(local.capabilities.selfHostOnly).toBe(true);
  });

  it('writes bytes to disk and returns a relative URL + on-disk ref', async () => {
    const bytes = Buffer.from('hello local disk');
    const res = await local.upload(bytes, { filename: 'note.txt', mime: 'text/plain' }, {});

    expect(res.url).toMatch(/^\/uploads\/local\/[0-9a-f]{12}\.txt$/);
    expect(res.ref).toMatch(/^[0-9a-f]{12}\.txt$/);
    expect(res.bytes).toBe(bytes.length);

    // The ref locates the file on disk (under its shard subdir) and it round-trips
    // byte-for-byte.
    const onDisk = fs.readFileSync(local.resolveDiskPath(res.ref!));
    expect(onDisk.equals(bytes)).toBe(true);
    // The file lives in a 2-char shard dir, not flat in the root.
    expect(local.resolveDiskPath(res.ref!)).toBe(path.join(dir, res.ref!.slice(0, 2), res.ref!));
    // No stray temp file was left behind in that shard dir.
    const shardDir = path.dirname(local.resolveDiskPath(res.ref!));
    expect(fs.readdirSync(shardDir).some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('takes the extension from the pipeline filename, not a hostile claim', async () => {
    const res = await local.upload(
      Buffer.from('x'),
      // The route always passes {basename}.{pipeline-ext}; even a traversal-y
      // basename can only affect the (re-sanitized) extension, never the path.
      { filename: '../../etc/passwd.png', mime: 'image/png' },
      {},
    );
    expect(res.ref).toMatch(/^[0-9a-f]{12}\.png$/);
  });

  it('deletes the on-disk bytes for its ref (orphan reap)', async () => {
    const res = await local.upload(
      Buffer.from('to-delete'),
      { filename: 'x.txt', mime: 'text/plain' },
      {},
    );
    const full = local.resolveDiskPath(res.ref!);
    expect(fs.existsSync(full)).toBe(true);
    await local.delete(res.ref!, {});
    expect(fs.existsSync(full)).toBe(false);
  });

  it('delete of an already-missing ref is a no-op', async () => {
    await expect(local.delete('deadbeef0000.png', {})).resolves.toBeUndefined();
  });

  it('resolveDiskPath refuses traversal outside the storage root', () => {
    expect(() => local.resolveDiskPath('../escape.png')).toThrow(/unsafe/);
    expect(() => local.resolveDiskPath('../../etc/passwd')).toThrow(/unsafe/);
    // A legitimate key resolves inside a 2-char shard dir under the root.
    expect(local.resolveDiskPath('a1b2c3d4e5f6.png')).toBe(
      path.join(dir, 'a1', 'a1b2c3d4e5f6.png'),
    );
  });
});
