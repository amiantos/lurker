// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The activity feed: highlights and other people's reactions to the user's
// lines, merged newest first, paged by a cursor per source. The paging is the
// part with teeth — walked end to end below, it must hand back every item
// exactly once, including when a line's time and its insert order disagree.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { Network } from '../db/networks.js';

const ctx = setupTestDb('routes-activity');

let app: Express;
let agent: LurkerTestAgent;
let userId: number;
let net: Network;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let addReaction: typeof import('../db/reactions.js').addReaction;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let createUser: typeof import('../db/users.js').createUser;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  ({ addReaction } = await import('../db/reactions.js'));
  const router = (await import('./activity.js')).default;

  userId = createUser('act-alice').id;
  net = createNetwork(userId, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'alice' })!;
  app = createTestApp({ '/api/activity': router });
  agent = await createAuthedAgent(app, userId);
});

afterAll(() => ctx.cleanup());

// Minutes past a fixed hour, so tests can place items in time explicitly.
const at = (min: number) => new Date(Date.UTC(2026, 8, 25, 12, min)).toISOString();

function highlight(target: string, text: string, min: number, networkId = net.id): number {
  return Number(
    insertMessage({
      networkId,
      target,
      time: at(min),
      type: 'message',
      nick: 'bob',
      text,
      self: false,
      matchedRuleId: 1,
    }).id,
  );
}

function own(target: string, text: string, min: number, networkId = net.id): number {
  return Number(
    insertMessage({
      networkId,
      target,
      time: at(min),
      type: 'message',
      nick: 'alice',
      text,
      self: true,
    }).id,
  );
}

function react(messageId: number, nick: string, value: string, min: number, networkId = net.id) {
  addReaction({ messageId, networkId, nick, value, self: false, toSelf: true, time: at(min) });
}

type Item = { kind: string; id: number; nick: string; text?: string; value?: string };
const label = (i: Item) => (i.kind === 'reaction' ? `${i.nick} ${i.value}` : i.text);

// Every page, following `next` until it's null.
async function walk(query: string, limit: number): Promise<Item[]> {
  const all: Item[] = [];
  let cursor = '';
  for (let pages = 0; pages < 50; pages++) {
    const res = await agent.get(`/api/activity?${query}&limit=${limit}${cursor}`);
    expect(res.status).toBe(200);
    all.push(...res.body.items);
    const next = res.body.next as { beforeMessage?: number; beforeReaction?: number } | null;
    if (!next) return all;
    cursor =
      (next.beforeMessage ? `&beforeMessage=${next.beforeMessage}` : '') +
      (next.beforeReaction ? `&beforeReaction=${next.beforeReaction}` : '');
  }
  throw new Error('activity feed never ended');
}

describe('GET /api/activity', () => {
  it('requires authentication', async () => {
    const res = await createAnonAgent(app).get('/api/activity');
    expect(res.status).toBe(401);
  });

  it('interleaves highlights and reactions by when they happened', async () => {
    const mine = own('#mix', 'my line', 0);
    highlight('#mix', 'alice: first', 1);
    react(mine, 'carol', '👍', 2);
    highlight('#mix', 'alice: second', 3);
    react(mine, 'dave', 'lol', 4);

    const res = await agent.get('/api/activity?target=%23mix');
    expect(res.body.items.map(label)).toEqual([
      'dave lol',
      'alice: second',
      'carol 👍',
      'alice: first',
    ]);
    // A reaction row points at the line it's on — the jump target.
    const reaction = res.body.items[0];
    expect(reaction).toMatchObject({ kind: 'reaction', id: mine, text: 'my line' });
    expect(res.body.next).toBeNull();
  });

  it('pages through both sources, every item exactly once', async () => {
    const mine = own('#page', 'mine', 0);
    for (let i = 1; i <= 7; i++) {
      highlight('#page', `h${i}`, i * 2);
      react(mine, `r${i}`, '👍', i * 2 + 1);
    }
    for (const limit of [1, 2, 3, 5, 50]) {
      const items = await walk('target=%23page', limit);
      expect(items.map(label)).toEqual([
        'r7 👍',
        'h7',
        'r6 👍',
        'h6',
        'r5 👍',
        'h5',
        'r4 👍',
        'h4',
        'r3 👍',
        'h3',
        'r2 👍',
        'h2',
        'r1 👍',
        'h1',
      ]);
    }
  });

  // A line stored LATER can carry an EARLIER time (server-time on a replayed
  // or delayed line). Each source must still be consumed in its own order, or
  // the per-source cursor jumps past what the merge skipped.
  it('loses nothing when a line’s time and its insert order disagree', async () => {
    const mine = own('#skew', 'mine', 0);
    highlight('#skew', 'late-stored-but-old', 10);
    react(mine, 'carol', '🎉', 20);
    highlight('#skew', 'stored-second', 30);
    // Stored after everything above, stamped before all of it.
    highlight('#skew', 'replayed', 5);
    for (const limit of [1, 2, 3, 50]) {
      const items = await walk('target=%23skew', limit);
      const labels = items.map(label);
      expect(labels.sort()).toEqual(
        ['carol 🎉', 'late-stored-but-old', 'replayed', 'stored-second'].sort(),
      );
    }
  });

  it('applies the filters to both sources, and never shows another user’s', async () => {
    const mine = own('#flt', 'filter me', 0);
    highlight('#flt', 'alice: from bob', 1);
    react(mine, 'carol', '👍', 2);

    const mallory = createUser('act-mallory');
    const theirs = createNetwork(mallory.id, {
      name: 'theirs',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'mallory',
    })!;
    react(own('#flt', 'not alice’s', 3, theirs.id), 'carol', '🎉', 4, theirs.id);
    highlight('#flt', 'not alice’s either', 5, theirs.id);

    const byCarol = await agent.get('/api/activity?target=%23flt&nick=carol');
    expect(byCarol.body.items.map(label)).toEqual(['carol 👍']);
    const byBob = await agent.get('/api/activity?target=%23flt&nick=bob');
    expect(byBob.body.items.map(label)).toEqual(['alice: from bob']);
    const all = await agent.get('/api/activity?target=%23flt');
    expect(all.body.items.map(label)).toEqual(['carol 👍', 'alice: from bob']);
  });
});
