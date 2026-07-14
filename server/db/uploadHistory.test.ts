// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-uploads-db-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let mod: typeof import('./uploadHistory.js');
let alice: ReturnType<typeof import('./users.js').createUser>;
let bob: ReturnType<typeof import('./users.js').createUser>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  mod = await import('./uploadHistory.js');
  alice = createUser('uh-alice');
  bob = createUser('uh-bob');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function insert(
  userId: number,
  overrides: Partial<import('./uploadHistory.js').InsertUploadFields> = {},
): number {
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
    const row = list.find((r) => r.id === id)!;
    expect(row.has_thumbnail).toBe(0);
    expect(row).not.toHaveProperty('thumbnail');
  });

  it('paginates by id < before', () => {
    const ids: number[] = [];
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

// #547. Its own user, seeded once: the suites above share alice/bob and keep adding
// rows to them, so exact-count assertions there would break every time someone adds a
// test above this line.
describe('listUploads — search + kind filter (#547)', () => {
  let carol: ReturnType<typeof import('./users.js').createUser>;
  const names = (rows: Array<{ filename: string | null }>) => rows.map((r) => r.filename);

  // Written oldest-first, so `id DESC` returns this list reversed.
  const SEEDED: Array<[string, string]> = [
    ['vacation.png', 'image/webp'],
    ['screenshot-march.png', 'image/webp'],
    ['notes.txt', 'text/plain'],
    ['clip.mp4', 'video/mp4'],
    ['song.mp3', 'audio/mpeg'],
    ['SCREAMING-SHOT.PNG', 'image/webp'],
    // Filenames that are made of LIKE metacharacters. These are the entire reason
    // likeTerm() exists.
    ['100%-zoom.png', 'image/webp'],
    ['snap_shot.png', 'image/webp'],
  ];

  beforeAll(() => {
    carol = createUser('uh-carol');
    for (const [filename, mime] of SEEDED) {
      insert(carol.id, { filename, mime, url: `https://x0.at/${filename}` });
    }
  });

  it('matches a filename substring, newest first', () => {
    // Substring, not prefix: "sho" is inside screen-SHO-t too.
    expect(names(mod.listUploads(carol.id, { q: 'sho' }))).toEqual([
      'snap_shot.png',
      'SCREAMING-SHOT.PNG',
      'screenshot-march.png',
    ]);
  });

  // SQLite's LIKE is case-insensitive for ASCII, and someone typing "shot" plainly
  // means to find "SHOT.PNG" as well.
  it('is case-insensitive', () => {
    expect(names(mod.listUploads(carol.id, { q: 'SCREAMING' }))).toEqual(['SCREAMING-SHOT.PNG']);
  });

  // ⚠ The bug likeTerm() exists to prevent. Unescaped, `%` and `_` are LIKE WILDCARDS
  // rather than characters — searching "100%" would match every filename containing
  // "100", and a lone "%" would match the entire history. A search box that silently
  // honours wildcards is a search box that lies about what it found.
  it('treats % as a literal, not a wildcard', () => {
    expect(names(mod.listUploads(carol.id, { q: '100%' }))).toEqual(['100%-zoom.png']);
    // A bare "%" finds the one file with a literal % in its name — NOT the whole
    // history, which is what an unescaped wildcard would have returned.
    expect(names(mod.listUploads(carol.id, { q: '%' }))).toEqual(['100%-zoom.png']);
  });

  it('treats _ as a literal, not a single-character wildcard', () => {
    expect(names(mod.listUploads(carol.id, { q: 'snap_shot' }))).toEqual(['snap_shot.png']);
    // Unescaped, `_` would match every filename with at least one character.
    expect(names(mod.listUploads(carol.id, { q: '_' }))).toEqual(['snap_shot.png']);
  });

  it('finds nothing for a term that matches nothing', () => {
    expect(mod.listUploads(carol.id, { q: 'nonexistent' })).toEqual([]);
  });

  it.each([
    ['image', 5],
    ['video', 1],
    ['audio', 1],
    ['text', 1],
  ] as const)('filters to kind=%s', (kind, count) => {
    const rows = mod.listUploads(carol.id, { kind });
    expect(rows.length).toBe(count);
    expect(rows.every((r) => (r.mime || '').startsWith(`${kind}/`))).toBe(true);
  });

  it('ANDs the search term with the kind', () => {
    expect(names(mod.listUploads(carol.id, { q: 'clip', kind: 'video' }))).toEqual(['clip.mp4']);
    // Same term, wrong kind → nothing. If the clauses OR'd, this would return the mp4.
    expect(mod.listUploads(carol.id, { q: 'clip', kind: 'image' })).toEqual([]);
  });

  // Keyset pagination has to keep working once a WHERE clause joins it: a cursor that
  // ignored the filter would page through the UNFILTERED sequence and silently skip
  // matches.
  it('pages a filtered result set with the id cursor', () => {
    const all = mod.listUploads(carol.id, { kind: 'image' });
    expect(all.length).toBe(5);

    const page1 = mod.listUploads(carol.id, { kind: 'image', limit: 2 });
    expect(names(page1)).toEqual(names(all.slice(0, 2)));

    const page2 = mod.listUploads(carol.id, {
      kind: 'image',
      limit: 2,
      before: page1[page1.length - 1].id,
    });
    expect(names(page2)).toEqual(names(all.slice(2, 4)));
  });

  it('scopes a filtered query to the asking user', () => {
    insert(bob.id, { filename: 'vacation.png', mime: 'image/webp' });
    // Both own a 'vacation.png'; neither sees the other's.
    expect(mod.listUploads(carol.id, { q: 'vacation' }).length).toBe(1);
    expect(mod.listUploads(bob.id, { q: 'vacation' }).length).toBe(1);
    expect(mod.listUploads(bob.id, { q: 'SCREAMING' })).toEqual([]);
  });
});

describe('getThumbnail / deleteUpload', () => {
  it('returns thumbnail bytes only for owned rows', () => {
    const id = insert(alice.id);
    expect(mod.getThumbnail(alice.id, id)!.thumbnail).toEqual(Buffer.from([1, 2, 3]));
    expect(mod.getThumbnail(bob.id, id)).toBeUndefined();
  });

  it('deleteUpload is owner-scoped', () => {
    const id = insert(alice.id);
    expect(mod.deleteUpload(bob.id, id)).toBe(false);
    expect(mod.deleteUpload(alice.id, id)).toBe(true);
    expect(mod.getThumbnail(alice.id, id)).toBeUndefined();
  });
});
