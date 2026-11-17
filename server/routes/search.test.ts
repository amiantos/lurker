// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// GET /api/search — the REST face of the search_messages verb (#676). These
// pin the route's own contract (params in, {items, nextBefore} out, error
// mapping); the search behavior itself is covered by searchMessages' and the
// verb's tests.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const ctx = setupTestDb('routes-search');

let app: Express;
let agent: LurkerTestAgent;
let user: User;
let net: Network;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let createUser: typeof import('../db/users.js').createUser;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  const router = (await import('./search.js')).default;

  user = createUser('search-rest-alice');
  net = createNetwork(user.id, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!;

  app = createTestApp({ '/api/search': router });
  agent = await createAuthedAgent(app, user.id);
});

afterAll(() => ctx.cleanup());

function chat(target: string, nick: string, text: string) {
  return insertMessage({
    networkId: net.id,
    target,
    time: new Date().toISOString(),
    type: 'message',
    nick,
    text,
    self: false,
  });
}

describe('GET /api/search', () => {
  it('requires authentication', async () => {
    const res = await createAnonAgent(app).get('/api/search?q=anything');
    expect(res.status).toBe(401);
  });

  it('free text returns decorated matches newest-first with the feed contract', async () => {
    const miss = chat('#dev', 'bob', 'unrelated chatter').id;
    const hit1 = chat('#dev', 'bob', 'the quokka is loose').id;
    const hit2 = chat('#ops', 'carol', 'quokka spotted again').id;

    const res = await agent.get('/api/search?q=quokka');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((r: { id: number }) => r.id);
    expect(ids).toEqual([hit2, hit1]);
    expect(ids).not.toContain(miss);
    // Decorated event shape, `networkName` included.
    expect(res.body.items[0].networkName).toBe('libera');
    expect(res.body.items[0].text).toBe('quokka spotted again');
    expect(res.body.nextBefore).toBeNull();
  });

  it('filter-only searches work without a q param', async () => {
    chat('#filter', 'zelda', 'no keyword here');
    const res = await agent.get('/api/search?nick=ZELDA');
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { nick: string }) => r.nick)).toEqual(['zelda']);
  });

  it('repeated nick params OR-match (alts)', async () => {
    chat('#alts', 'main-nick', 'from the main');
    chat('#alts', 'alt-nick', 'from the alt');
    const res = await agent.get('/api/search?nick=main-nick&nick=alt-nick&target=%23alts');
    expect(res.body.items).toHaveLength(2);
  });

  it('paginates via nextBefore, not hasMore', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(Number(chat('#page', 'dana', `entry ${i}`).id));

    const page1 = await agent.get('/api/search?nick=dana&limit=2');
    expect(page1.body.items.map((r: { id: number }) => r.id)).toEqual([ids[2], ids[1]]);
    expect(page1.body.nextBefore).toBe(ids[1]);
    expect(page1.body.hasMore).toBeUndefined();

    const page2 = await agent.get(`/api/search?nick=dana&limit=2&before=${page1.body.nextBefore}`);
    expect(page2.body.items.map((r: { id: number }) => r.id)).toEqual([ids[0]]);
    expect(page2.body.nextBefore).toBeNull();
  });

  it('an empty query with no filters returns an empty page', async () => {
    const res = await agent.get('/api/search');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextBefore: null });
  });

  it("404s a networkId the caller doesn't own", async () => {
    const other = createUser('search-rest-mallory');
    const otherNet = createNetwork(other.id, {
      name: 'oftc',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'mallory',
    })!;
    const res = await agent.get(`/api/search?q=anything&networkId=${otherNet.id}`);
    expect(res.status).toBe(404);
  });
});
