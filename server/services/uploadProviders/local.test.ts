// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as local from './local.js';
import { bufferSource } from './source.js';

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
    const res = await local.upload(
      bufferSource(bytes),
      { filename: 'note.txt', mime: 'text/plain' },
      {},
    );

    expect(res.url).toMatch(/^\/uploads\/[0-9a-f]{12}\.txt$/);
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
      bufferSource(Buffer.from('x')),
      // The route always passes {basename}.{pipeline-ext}; even a traversal-y
      // basename can only affect the (re-sanitized) extension, never the path.
      { filename: '../../etc/passwd.png', mime: 'image/png' },
      {},
    );
    expect(res.ref).toMatch(/^[0-9a-f]{12}\.png$/);
  });

  it('deletes the on-disk bytes for its ref (orphan reap)', async () => {
    const res = await local.upload(
      bufferSource(Buffer.from('to-delete')),
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

  it('links to public_base_url when one is set, built from the parsed origin', async () => {
    const meta = { filename: 'note.txt', mime: 'text/plain' };
    const links: string[] = [];
    for (const value of [
      ' https://files.example.com/ ',
      'HTTPS://Files.Example.com',
      'https:\\\\files.example.com',
    ]) {
      const res = await local.upload(bufferSource(Buffer.from('a')), meta, {
        public_base_url: value,
      });
      links.push(res.url.replace(res.ref!, '<key>'));
    }
    expect(links).toEqual(Array(3).fill('https://files.example.com/uploads/<key>'));
    const port = await local.upload(bufferSource(Buffer.from('b')), meta, {
      public_base_url: 'https://files.example.com:8443',
    });
    expect(port.url).toBe(`https://files.example.com:8443/uploads/${port.ref}`);
  });

  // Each of these would put something other than /uploads/<key> after the host,
  // or an http link in an https page.
  const BAD_BASES = [
    'files.example.com',
    'http://files.example.com',
    'ftp://files.example.com',
    'javascript:alert(1)',
    'https://files.example.com/irc',
    'https://files.example.com?x=1',
    'https://files.example.com?',
    'https://files.example.com#top',
    'https://files.example.com#',
    'https://user:pw@files.example.com',
  ];

  it('validateConfig refuses a public_base_url that would mangle the link', () => {
    const verdicts = Object.fromEntries(
      BAD_BASES.map((v) => [v, local.validateConfig({ public_base_url: v })]),
    );
    for (const v of BAD_BASES) expect(verdicts[v]).toMatch(/^Public base URL must be/);
    expect(local.validateConfig({ public_base_url: '' })).toBeNull();
    expect(local.validateConfig({ public_base_url: 'https://files.example.com' })).toBeNull();
    expect(local.validateConfig({})).toBeNull();
  });

  it('refuses an unusable stored public_base_url before writing', async () => {
    const before = fs.readdirSync(dir, { recursive: true }).length;
    const codes: Record<string, unknown> = {};
    for (const value of BAD_BASES) {
      codes[value] = await local
        .upload(
          bufferSource(Buffer.from('x')),
          { filename: 'x.txt', mime: 'text/plain' },
          { public_base_url: value },
        )
        .then(
          () => 'accepted',
          (err: { code?: string }) => err.code,
        );
    }
    expect(codes).toEqual(Object.fromEntries(BAD_BASES.map((v) => [v, 'PROVIDER_ERROR'])));
    expect(fs.readdirSync(dir, { recursive: true }).length).toBe(before);
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
