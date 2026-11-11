// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The search process (searchRunner.ts): the same rows as the in-process
// search, the event loop left free while a statement runs, and a statement
// stopped when its asker goes or its time is up.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { insertMessage, searchMessages } from '../db/messages.js';
import {
  runSearchQuery,
  searchMessagesOffLoop,
  stopSearchRunner,
  type SearchError,
} from './searchRunner.js';

// A statement that runs until it is stopped (minutes, on any machine), and
// reads no table: the walk a real search does over a large instance.
const ENDLESS = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1e12)
                 SELECT count(*) AS n FROM c`;

let userId: number;
let otherId: number;
let networkId: number;

beforeAll(() => {
  userId = createUser('runner-alice').id;
  otherId = createUser('runner-bob').id;
  networkId = createNetwork(userId, {
    name: 'n',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!.id;
  const theirs = createNetwork(otherId, {
    name: 'n',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'bob',
  })!.id;
  const say = (net: number, target: string, nick: string, text: string) =>
    insertMessage({
      networkId: net,
      target,
      time: new Date().toISOString(),
      type: 'message',
      nick,
      text,
    });
  say(networkId, '#a', 'carol', 'the attachments are in the thread');
  say(networkId, '#b', 'dave', 'no attachments here');
  say(networkId, 'carol', 'carol', 'sending attachments now');
  say(networkId, '#a', 'carol', 'unrelated line');
  say(theirs, '#a', 'erin', 'attachments on another account');
});

afterEach(() => {
  delete process.env.LURKER_SEARCH_TIME_LIMIT_MS;
});
afterAll(() => stopSearchRunner());

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: SearchError) => err.code,
  );

describe('searchMessagesOffLoop', () => {
  it('returns what the in-process search returns, for every kind of search', async () => {
    const shapes = [
      { query: 'attachments' },
      { query: 'attachments', networkId, target: '#a' },
      { query: 'attachments', target: 'carol' },
      { nick: 'carol' },
      { query: 'attachments', limit: 1 },
      { query: 'nosuchword' },
    ];
    for (const opts of shapes) {
      expect(await searchMessagesOffLoop(userId, opts)).toEqual(searchMessages(userId, opts));
    }
    expect((await searchMessagesOffLoop(userId, { query: 'attachments' })).length).toBe(3);
  });

  it("never returns another account's rows", async () => {
    const rows = await searchMessagesOffLoop(otherId, { query: 'attachments' });
    expect(rows.map((r) => r.nick)).toEqual(['erin']);
  });

  it('runs nothing for an empty search', async () => {
    expect(await searchMessagesOffLoop(userId, {})).toEqual([]);
  });
});

describe('runSearchQuery', () => {
  it('leaves the event loop free while a statement runs, and stops it when its asker goes', async () => {
    const asker = new AbortController();
    const search = codeOf(runSearchQuery(ENDLESS, [], { signal: asker.signal }));
    // In-process, this statement would hold the loop and no timer would fire.
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(performance.now() - started).toBeLessThan(1000);
    asker.abort();
    expect(await search).toBe('search_aborted');
    // A new process serves the next search.
    expect(await runSearchQuery('SELECT 1 AS one', [])).toEqual([{ one: 1 }]);
  });

  it('stops a statement that runs past the time limit', async () => {
    process.env.LURKER_SEARCH_TIME_LIMIT_MS = '150';
    expect(await codeOf(runSearchQuery(ENDLESS, []))).toBe('search_timeout');
    expect(await runSearchQuery('SELECT 2 AS two', [])).toEqual([{ two: 2 }]);
  });

  it('drops a waiting search whose asker went, without running it or disturbing the one that runs', async () => {
    const first = new AbortController();
    const running = codeOf(runSearchQuery(ENDLESS, [], { signal: first.signal }));
    const second = new AbortController();
    const waiting = codeOf(runSearchQuery('SELECT 1', [], { signal: second.signal }));
    const third = runSearchQuery('SELECT 3 AS three', []);
    second.abort();
    expect(await waiting).toBe('search_aborted');
    // The first is still the one running; the third gets its turn after it.
    first.abort();
    expect(await running).toBe('search_aborted');
    expect(await third).toEqual([{ three: 3 }]);
  });

  it('refuses a search whose asker was gone before it was asked', async () => {
    const asker = new AbortController();
    asker.abort();
    expect(await codeOf(runSearchQuery('SELECT 1', [], { signal: asker.signal }))).toBe(
      'search_aborted',
    );
  });

  it('reports a statement that fails, and keeps serving', async () => {
    expect(await codeOf(runSearchQuery('SELECT * FROM no_such_table', []))).toBe('search_failed');
    expect(await runSearchQuery('SELECT 4 AS four', [])).toEqual([{ four: 4 }]);
  });

  it('cannot write: the connection is read-only', async () => {
    expect(await codeOf(runSearchQuery(`DELETE FROM messages`, []))).toBe('search_failed');
    expect(searchMessages(userId, { query: 'attachments' }).length).toBe(3);
  });
});
