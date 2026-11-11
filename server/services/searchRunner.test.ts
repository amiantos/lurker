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
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATABASE_FILE } from '../db/index.js';
import {
  MAX_WAITING,
  MAX_WAITING_PER_OWNER,
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

describe('sharing the one slot', () => {
  // Hold the slot with a statement that never ends, and hand back what ends it.
  function holdSlot(owner: number) {
    const asker = new AbortController();
    const held = codeOf(runSearchQuery(ENDLESS, [], { signal: asker.signal, owner }));
    return async () => {
      asker.abort();
      await held;
    };
  }

  it('serves the owner who has waited longest, not whoever asked most', async () => {
    const release = holdSlot(1);
    const order: string[] = [];
    const ask = (owner: number, name: string) =>
      runSearchQuery('SELECT 1', [], { owner }).then(() => order.push(name));
    // Owner 1 asks three times before owner 2 asks once.
    const asked = [ask(1, 'a1'), ask(1, 'a2'), ask(1, 'a3'), ask(2, 'b1')];
    await release();
    await Promise.all(asked);
    // Owner 1 was served last (the held search): owner 2 goes first.
    expect(order).toEqual(['b1', 'a1', 'a2', 'a3']);
  });

  it("a newer search displaces its owner's oldest waiting one past the per-owner bound", async () => {
    const release = holdSlot(7);
    const waiting = Array.from({ length: MAX_WAITING_PER_OWNER }, (_, i) =>
      codeOf(runSearchQuery(`SELECT ${i} AS n`, [], { owner: 7 })),
    );
    const newest = runSearchQuery('SELECT 99 AS n', [], { owner: 7 });
    // The oldest gave way at once; the rest still wait.
    expect(await waiting[0]).toBe('search_aborted');
    await release();
    expect(await Promise.all(waiting.slice(1))).toEqual(waiting.slice(1).map(() => 'resolved'));
    expect(await newest).toEqual([{ n: 99 }]);
  });

  it('refuses a search once too many wait in all', async () => {
    const release = holdSlot(1);
    // Each from its own owner, so none displaces another.
    const waiting = Array.from({ length: MAX_WAITING }, (_, i) =>
      codeOf(runSearchQuery('SELECT 1', [], { owner: 100 + i })),
    );
    expect(await codeOf(runSearchQuery('SELECT 1', [], { owner: 999 }))).toBe('search_busy');
    await release();
    expect(new Set(await Promise.all(waiting))).toEqual(new Set(['resolved']));
  });

  it('counts the wait toward the time limit: nobody waits longer than it for a turn', async () => {
    process.env.LURKER_SEARCH_TIME_LIMIT_MS = '200';
    // The holder is stopped at its own limit (200 ms). The one waiting behind
    // it has a shorter one, and is told when that is up, without ever running.
    const holder = codeOf(runSearchQuery(ENDLESS, [], { owner: 1 }));
    process.env.LURKER_SEARCH_TIME_LIMIT_MS = '50';
    const waiter = codeOf(runSearchQuery('SELECT 1', [], { owner: 2 }));
    expect(await waiter).toBe('search_timeout');
    expect(await holder).toBe('search_timeout');
  });

  it('a limit too large for a timer is clamped, not turned into no time at all', async () => {
    process.env.LURKER_SEARCH_TIME_LIMIT_MS = '9999999999';
    expect(await runSearchQuery('SELECT 5 AS five', [])).toEqual([{ five: 5 }]);
  });

  it('stopSearchRunner tells the running search and the waiting ones, and the next search still works', async () => {
    const running = codeOf(runSearchQuery(ENDLESS, [], { owner: 1 }));
    const waiting = codeOf(runSearchQuery('SELECT 1', [], { owner: 2 }));
    stopSearchRunner();
    expect(await waiting).toBe('search_aborted');
    expect(await running).toBe('search_aborted');
    expect(await runSearchQuery('SELECT 6 AS six', [])).toEqual([{ six: 6 }]);
  });
});

describe('the search process', () => {
  it('ends itself, mid-statement, when its parent dies without a word', async () => {
    // A stand-in parent that forks the search process the way the runner
    // does, starts a statement that never ends, and reports the child's pid.
    const entry = fileURLToPath(new URL('../searchProcess.ts', import.meta.url));
    const parent = fork(
      '-e',
      [
        `const { fork } = require('node:child_process');
         const child = fork(${JSON.stringify(entry)}, [${JSON.stringify(DATABASE_FILE)}]);
         child.send({ id: 1, sql: ${JSON.stringify(ENDLESS)}, params: [] });
         process.send(child.pid);
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const pid = await new Promise<number>((resolve) => parent.once('message', resolve));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Let the statement start, then kill the parent the way nothing can catch.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive()).toBe(true);
    parent.kill('SIGKILL');
    const deadline = Date.now() + 8000;
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const survived = alive();
    if (survived) process.kill(pid, 'SIGKILL');
    expect(survived).toBe(false);
  }, 15_000);
});
