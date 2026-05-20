// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent, createAnonAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const ctx = setupTestDb('routes-bookmarks');

let app: Express;
let aliceAgent: LurkerTestAgent;
let alice: User;
let bob: User;
let aliceNet: Network;
let bobNet: Network;
let addBookmark: typeof import('../db/bookmarks.js').addBookmark;
let insertMessage: typeof import('../db/messages.js').insertMessage;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ insertMessage } = await import('../db/messages.js'));
  ({ addBookmark } = await import('../db/bookmarks.js'));
  const router = (await import('./bookmarks.js')).default;

  alice = createUser('alice');
  bob = createUser('bob');
  aliceNet = createNetwork(alice.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'alice' })!;
  bobNet = createNetwork(bob.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'bob' })!;

  app = createTestApp({ '/api/bookmarks': router });
  aliceAgent = await createAuthedAgent(app, alice.id);
});

afterAll(() => ctx.cleanup());

function chat(networkId: number, target: string, nick: string, text: string) {
  return insertMessage({
    networkId, target, time: new Date().toISOString(),
    type: 'message', nick, text, self: false,
  });
}

describe('GET /api/bookmarks', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await createAnonAgent(app).get('/api/bookmarks');
    expect(res.status).toBe(401);
  });

  it('returns only the caller\'s bookmarks', async () => {
    const aliceMsg = Number(chat(aliceNet.id, '#meta', 'someone', 'visible').id);
    const bobMsg = Number(chat(bobNet.id, '#meta', 'someone', 'hidden').id);
    addBookmark(alice.id, aliceMsg);
    addBookmark(bob.id, bobMsg);

    const res = await aliceAgent.get('/api/bookmarks');
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { id: number }) => r.id)).toContain(aliceMsg);
    expect(res.body.items.map((r: { id: number }) => r.id)).not.toContain(bobMsg);
  });

  it('paginates with limit + cursor', async () => {
    const me = (await import('../db/users.js')).createUser('bm-paginate');
    const net = (await import('../db/networks.js')).createNetwork(me.id, {
      name: 'libera', host: 'h', port: 6697, tls: true, nick: 'me',
    })!;
    const ids: Array<number | bigint> = [];
    for (let i = 0; i < 5; i += 1) {
      const { id } = chat(net.id, '#meta', 'me', `m${i}`);
      addBookmark(me.id, Number(id));
      ids.push(id);
    }
    const agent = await createAuthedAgent(app, me.id);
    const page1 = await agent.get('/api/bookmarks?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0].id).toBe(ids[4]);
    expect(page1.body.nextBefore).toBe(ids[3]);

    const page2 = await agent.get(`/api/bookmarks?limit=2&before=${page1.body.nextBefore}`);
    expect(page2.body.items.map((r: { id: number }) => r.id)).toEqual([ids[2], ids[1]]);
    expect(page2.body.nextBefore).toBe(ids[1]);

    const page3 = await agent.get(`/api/bookmarks?limit=2&before=${page2.body.nextBefore}`);
    expect(page3.body.items.map((r: { id: number }) => r.id)).toEqual([ids[0]]);
    // Page didn't fill — no more pages.
    expect(page3.body.nextBefore).toBeNull();
  });

  it('clamps limit to MAX_LIMIT and falls back to default for garbage values', async () => {
    // Just spot-check that bad limit values don't crash; precise clamp is
    // exercised by the DB layer's own tests.
    const r1 = await aliceAgent.get('/api/bookmarks?limit=99999');
    expect(r1.status).toBe(200);
    const r2 = await aliceAgent.get('/api/bookmarks?limit=NaN');
    expect(r2.status).toBe(200);
    const r3 = await aliceAgent.get('/api/bookmarks?limit=-5');
    expect(r3.status).toBe(200);
  });
});
