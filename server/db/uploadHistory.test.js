// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-uploads-db-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser;
let mod;
let alice;
let bob;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  mod = await import('./uploadHistory.js');
  alice = createUser('uh-alice');
  bob = createUser('uh-bob');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function insert(userId, overrides = {}) {
  return mod.insertUpload(userId, {
    provider: 'x0',
    url: 'https://x0.at/test',
    filename: 'a.png',
    mime: 'image/png',
    byte_size: 1024,
    width: 16,
    height: 16,
    thumbnail: Buffer.from([1, 2, 3]),
    ...overrides,
  });
}

describe('insertUpload / listUploads', () => {
  it('newest-first ordering, scoped to user', () => {
    const idA = insert(alice.id, { url: 'https://x0.at/a' });
    insert(bob.id, { url: 'https://x0.at/bob' });
    const idC = insert(alice.id, { url: 'https://x0.at/c' });
    const aliceList = mod.listUploads(alice.id);
    expect(aliceList[0].id).toBe(idC);
    expect(aliceList[1].id).toBe(idA);
    expect(aliceList.every((r) => r.url.startsWith('https://x0.at/'))).toBe(true);
  });

  it('has_thumbnail flag exposed without shipping bytes', () => {
    const id = insert(alice.id, { thumbnail: null, mime: 'text/plain' });
    const list = mod.listUploads(alice.id);
    const row = list.find((r) => r.id === id);
    expect(row.has_thumbnail).toBe(0);
    expect(row).not.toHaveProperty('thumbnail');
  });

  it('paginates by id < before', () => {
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(insert(bob.id, { url: `https://x0.at/p${i}` }));
    const page1 = mod.listUploads(bob.id, { limit: 2 });
    const page2 = mod.listUploads(bob.id, { limit: 2, before: page1[page1.length - 1].id });
    expect(page2.length).toBeGreaterThan(0);
    expect(Math.max(...page2.map((r) => r.id))).toBeLessThan(page1[page1.length - 1].id);
  });

  it('clamps limit between 1 and 200', () => {
    expect(mod.listUploads(alice.id, { limit: 99999 }).length).toBeLessThanOrEqual(200);
    expect(mod.listUploads(alice.id, { limit: 0 }).length).toBeGreaterThanOrEqual(1);
  });
});

describe('getThumbnail / deleteUpload', () => {
  it('returns thumbnail bytes only for owned rows', () => {
    const id = insert(alice.id);
    expect(mod.getThumbnail(alice.id, id).thumbnail).toEqual(Buffer.from([1, 2, 3]));
    expect(mod.getThumbnail(bob.id, id)).toBeUndefined();
  });

  it('deleteUpload is owner-scoped', () => {
    const id = insert(alice.id);
    expect(mod.deleteUpload(bob.id, id)).toBe(false);
    expect(mod.deleteUpload(alice.id, id)).toBe(true);
    expect(mod.getThumbnail(alice.id, id)).toBeUndefined();
  });
});
