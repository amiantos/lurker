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
let listMessages: typeof import('./messages.js').listMessages;
let addBookmark: typeof import('./bookmarks.js').addBookmark;
let removeBookmark: typeof import('./bookmarks.js').removeBookmark;
let isBookmarked: typeof import('./bookmarks.js').isBookmarked;
let listBookmarksForUser: typeof import('./bookmarks.js').listBookmarksForUser;

beforeAll(async () => {
  ({ createUser, deleteUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ insertMessage, listMessages } = await import('./messages.js'));
  ({ addBookmark, removeBookmark, isBookmarked, listBookmarksForUser } =
    await import('./bookmarks.js'));
});

// The ids a user has saved, newest-first, read back through the same paginated
// path the REST list uses. There is deliberately no all-ids accessor to call
// here: shipping every id at once is exactly what the per-row `bookmarked`
// column replaced, so the tests read the way production does.
function savedIds(userId: number): number[] {
  return listBookmarksForUser(userId, { limit: 200 }).map((r) => r.id);
}

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkNetwork(userId: number, name: string) {
  return createNetwork(userId, {
    name,
    host: 'h',
    port: 6697,
    tls: true,
    nick: name,
  });
}

function chat(networkId: number, target: string, nick: string, text: string) {
  const result = insertMessage({
    networkId,
    target,
    time: new Date().toISOString(),
    type: 'message',
    nick,
    text,
    self: false,
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
    expect(savedIds(u.id)).toEqual([id]);
  });

  it("rejects bookmarking another user's message (ownership check)", () => {
    const owner = createUser('bm-owner');
    const intruder = createUser('bm-intruder');
    const net = mkNetwork(owner.id, 'libera');
    const { id } = chat(net!.id, '#secret', 'owner', 'private');
    // Insert SUCCEEDS at the SQL layer but writes zero rows because the
    // ownership check inside the INSERT statement fails. The function
    // reports false (not bookmarked after the call).
    expect(addBookmark(intruder.id, id)).toBe(false);
    expect(savedIds(intruder.id)).toEqual([]);
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
    expect(savedIds(u.id)).toEqual([c, b, a]);
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
    expect(savedIds(u.id)).toEqual([id]);
    deleteUser(u.id);
    expect(savedIds(u.id)).toEqual([]);
  });
});

// The `bookmarked` flag on message rows is what replaced the connect-burst id
// snapshot: the client learns which lines it has saved from the lines
// themselves, so the state it holds is bounded by what it has loaded rather
// than by everything the account has ever saved.
describe('bookmarked flag on message rows', () => {
  it('rides on the row, and only for the rows actually saved', () => {
    const u = createUser('bmcol-alice');
    const net = mkNetwork(u.id, 'libera');
    const plain = chat(net!.id, '#meta', 'alice', 'unsaved').id;
    const saved = chat(net!.id, '#meta', 'alice', 'saved').id;
    addBookmark(u.id, saved);

    const byId = new Map(listMessages(net!.id, '#meta').map((e) => [e.id, e]));
    expect(byId.get(saved)!.bookmarked).toBe(true);
    // Absent, not `false` — an unbookmarked row must not grow a field, since
    // that is nearly every row in every backlog ever sent.
    expect(byId.get(plain)).not.toHaveProperty('bookmarked');
  });

  it('clears when the bookmark is removed', () => {
    const u = createUser('bmcol-bob');
    const net = mkNetwork(u.id, 'libera');
    const { id } = chat(net!.id, '#meta', 'bob', 'hi');
    addBookmark(u.id, id);
    expect(listMessages(net!.id, '#meta')[0].bookmarked).toBe(true);
    removeBookmark(u.id, id);
    expect(listMessages(net!.id, '#meta')[0]).not.toHaveProperty('bookmarked');
  });

  it("does not leak another user's bookmark onto a row", () => {
    // The flag resolves its user through the message's OWN network, so a second
    // account bookmarking the same id is impossible — but were the derivation
    // ever loosened to a bare message_id match, this is what would break.
    const owner = createUser('bmcol-owner');
    const other = createUser('bmcol-other');
    const net = mkNetwork(owner.id, 'libera');
    const { id } = chat(net!.id, '#meta', 'owner', 'mine');
    expect(addBookmark(other.id, id)).toBe(false);
    expect(listMessages(net!.id, '#meta')[0]).not.toHaveProperty('bookmarked');
    expect(isBookmarked(owner.id, id)).toBe(false);
  });

  it('cannot be forged by a stray key in the message extra blob', () => {
    // `extra` is built from what a network sent us; `bookmarked` is a fact about
    // the reader's own account. rowToEvent applies the column AFTER the extra
    // spread so the former can never light up a line nobody saved.
    const u = createUser('bmcol-carol');
    const net = mkNetwork(u.id, 'libera');
    insertMessage({
      networkId: net!.id,
      target: '#meta',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'mallory',
      text: 'trust me',
      self: false,
      extra: { bookmarked: true },
    });
    expect(listMessages(net!.id, '#meta')[0]).not.toHaveProperty('bookmarked');
  });

  // A saved reply to you is still one — the same stamp every other read carries
  // (#993), and only the column may set it.
  it('carries the reply-to-you stamp, and only from the column', () => {
    const u = createUser('bm-replies');
    const net = mkNetwork(u.id, 'libera');
    const toMe = Number(
      insertMessage({
        networkId: net!.id,
        target: '#meta',
        time: new Date().toISOString(),
        type: 'message',
        nick: 'bob',
        text: 'good question',
        replyMsgid: 'm1',
        replyToSelf: true,
      }).id,
    );
    const forged = Number(
      insertMessage({
        networkId: net!.id,
        target: '#meta',
        time: new Date().toISOString(),
        type: 'message',
        nick: 'bob',
        text: 'not to you',
        extra: { replyToSelf: true },
      }).id,
    );
    addBookmark(u.id, toMe);
    addBookmark(u.id, forged);
    const rows = listBookmarksForUser(u.id, { limit: 10 });
    expect(rows.find((r) => r.id === toMe)).toMatchObject({ matched: true, replyToSelf: true });
    expect(rows.find((r) => r.id === forged)).not.toHaveProperty('replyToSelf');
  });
});
