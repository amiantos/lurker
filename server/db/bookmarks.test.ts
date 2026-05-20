// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let deleteUser: typeof import('./users.js').deleteUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let insertMessage: typeof import('./messages.js').insertMessage;
let addBookmark: typeof import('./bookmarks.js').addBookmark;
let removeBookmark: typeof import('./bookmarks.js').removeBookmark;
let isBookmarked: typeof import('./bookmarks.js').isBookmarked;
let listBookmarkIdsForUser: typeof import('./bookmarks.js').listBookmarkIdsForUser;
let listBookmarksForUser: typeof import('./bookmarks.js').listBookmarksForUser;

beforeAll(async () => {
  ({ createUser, deleteUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ insertMessage } = await import('./messages.js'));
  ({
    addBookmark,
    removeBookmark,
    isBookmarked,
    listBookmarkIdsForUser,
    listBookmarksForUser,
  } = await import('./bookmarks.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkNetwork(userId: number, name: string) {
  return createNetwork(userId, {
    name, host: 'h', port: 6697, tls: true, nick: name,
  });
}

function chat(networkId: number, target: string, nick: string, text: string) {
  const result = insertMessage({
    networkId, target, time: new Date().toISOString(),
    type: 'message', nick, text, self: false,
  });
  return { id: Number(result.id), alt: result.alt };
}

describe('bookmarks', () => {
  it('add → isBookmarked → remove round-trips', () => {
    const u = createUser('bm-alice');
    const net = mkNetwork(u.id, 'libera');
    const { id } = chat(net!.id, '#meta', 'alice', 'hello');
    expect(isBookmarked(u.id, id)).toBe(false);
    expect(addBookmark(u.id, id)).toBe(true);
    expect(isBookmarked(u.id, id)).toBe(true);
    removeBookmark(u.id, id);
    expect(isBookmarked(u.id, id)).toBe(false);
  });

  it('add is idempotent', () => {
    const u = createUser('bm-bob');
    const net = mkNetwork(u.id, 'libera');
    const { id } = chat(net!.id, '#meta', 'bob', 'hi');
    addBookmark(u.id, id);
    addBookmark(u.id, id);
    expect(listBookmarkIdsForUser(u.id)).toEqual([id]);
  });

  it('rejects bookmarking another user\'s message (ownership check)', () => {
    const owner = createUser('bm-owner');
    const intruder = createUser('bm-intruder');
    const net = mkNetwork(owner.id, 'libera');
    const { id } = chat(net!.id, '#secret', 'owner', 'private');
    // Insert SUCCEEDS at the SQL layer but writes zero rows because the
    // ownership check inside the INSERT statement fails. The function
    // reports false (not bookmarked after the call).
    expect(addBookmark(intruder.id, id)).toBe(false);
    expect(listBookmarkIdsForUser(intruder.id)).toEqual([]);
  });

  it('lists ids newest-first', () => {
    const u = createUser('bm-carol');
    const net = mkNetwork(u.id, 'libera');
    const a = chat(net!.id, '#meta', 'x', 'a').id;
    const b = chat(net!.id, '#meta', 'x', 'b').id;
    const c = chat(net!.id, '#meta', 'x', 'c').id;
    addBookmark(u.id, a);
    addBookmark(u.id, b);
    addBookmark(u.id, c);
    expect(listBookmarkIdsForUser(u.id)).toEqual([c, b, a]);
  });

  it('listBookmarksForUser returns rows with networkName + cursor pagination', () => {
    const u = createUser('bm-dave');
    const net = mkNetwork(u.id, 'irc');
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(chat(net!.id, '#meta', 'dave', `m${i}`).id);
      addBookmark(u.id, ids[i]);
    }
    const page1 = listBookmarksForUser(u.id, { limit: 2 });
    expect(page1).toHaveLength(2);
    expect(page1[0].id).toBe(ids[4]);
    expect(page1[0].networkName).toBe('irc');
    const page2 = listBookmarksForUser(u.id, { before: page1[1].id, limit: 2 });
    expect(page2.map((r) => r.id)).toEqual([ids[2], ids[1]]);
  });

  it('cascades on user delete', () => {
    const u = createUser('bm-eve');
    const net = mkNetwork(u.id, 'libera');
    const { id } = chat(net!.id, '#meta', 'eve', 'goodbye');
    addBookmark(u.id, id);
    expect(listBookmarkIdsForUser(u.id)).toEqual([id]);
    deleteUser(u.id);
    expect(listBookmarkIdsForUser(u.id)).toEqual([]);
  });
});
