// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent, createAnonAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const ctx = setupTestDb('routes-highlights');

let app: Express;
let agent: LurkerTestAgent;
let user: User;
let net: Network;
let insertMessage: typeof import('../db/messages.js').insertMessage;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ insertMessage } = await import('../db/messages.js'));
  const router = (await import('./highlights.js')).default;

  user = createUser('hl-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'alice' })!;

  app = createTestApp({ '/api/highlights': router });
  agent = await createAuthedAgent(app, user.id);
});

afterAll(() => ctx.cleanup());

function chat(target: string, nick: string, text: string, matchedRuleId: number | null) {
  return insertMessage({
    networkId: net.id, target, time: new Date().toISOString(),
    type: 'message', nick, text, self: false, matchedRuleId,
  });
}

describe('GET /api/highlights', () => {
  it('requires authentication', async () => {
    const res = await createAnonAgent(app).get('/api/highlights');
    expect(res.status).toBe(401);
  });

  it('returns matched messages newest-first, skipping unmatched ones', async () => {
    const unmatched = chat('#dev', 'bob', 'hello there', null).id;
    const hit1 = chat('#dev', 'bob', 'alice ping', 42).id;
    const hit2 = chat('#dev', 'carol', 'alice fyi', 42).id;

    const res = await agent.get('/api/highlights');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((r: { id: number }) => r.id);
    expect(ids).toEqual([hit2, hit1]);
    expect(ids).not.toContain(unmatched);
    // networkName is joined in so the modal can render the badge.
    expect(res.body.items[0].networkName).toBe('libera');
    expect(res.body.nextBefore).toBeNull();
  });

  it('paginates with limit + before cursor', async () => {
    const ids: Array<number | bigint> = [];
    for (let i = 0; i < 4; i += 1) ids.push(chat('#paginate', `n${i}`, `m${i}`, 7).id);
    const page1 = await agent.get('/api/highlights?limit=2&before=' + (Number(ids[ids.length - 1]) + 1));
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.items[0].id).toBe(ids[3]);
    expect(page1.body.nextBefore).toBe(ids[2]);
    const page2 = await agent.get(`/api/highlights?limit=2&before=${page1.body.nextBefore}`);
    expect(page2.body.items.map((r: { id: number }) => r.id)).toEqual([ids[1], ids[0]]);
  });

  it('caps limit to MAX_LIMIT silently', async () => {
    const res = await agent.get('/api/highlights?limit=99999');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});
