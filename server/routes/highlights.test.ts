// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

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

const ctx = setupTestDb('routes-highlights');

let app: Express;
let agent: LurkerTestAgent;
let user: User;
let net: Network;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let createNetwork: typeof import('../db/networks.js').createNetwork;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  const router = (await import('./highlights.js')).default;

  user = createUser('hl-alice');
  net = createNetwork(user.id, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!;

  app = createTestApp({ '/api/highlights': router });
  agent = await createAuthedAgent(app, user.id);
});

afterAll(() => ctx.cleanup());

function chat(target: string, nick: string, text: string, matchedRuleId: number | null) {
  return insertMessage({
    networkId: net.id,
    target,
    time: new Date().toISOString(),
    type: 'message',
    nick,
    text,
    self: false,
    matchedRuleId,
  });
}

function chatIgnored(target: string, nick: string, text: string, matchedRuleId: number | null) {
  return insertMessage({
    networkId: net.id,
    target,
    time: new Date().toISOString(),
    type: 'message',
    nick,
    text,
    self: false,
    matchedRuleId,
    fromIgnored: true,
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
    const page1 = await agent.get(
      '/api/highlights?limit=2&before=' + (Number(ids[ids.length - 1]) + 1),
    );
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

  it('omits matched rows whose sender was ignored at insert time', async () => {
    const visible = chat('#ig', 'eve', 'alice ping', 99).id;
    const hidden = chatIgnored('#ig', 'spammer', 'alice ping', 99).id;
    const res = await agent.get('/api/highlights?limit=50');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((r: { id: number }) => r.id);
    expect(ids).toContain(visible);
    expect(ids).not.toContain(hidden);
  });

  it('filters by nick (from:)', async () => {
    chat('#fromf', 'zara', 'alice ping', 50);
    chat('#fromf', 'yann', 'alice ping', 50);
    const res = await agent.get('/api/highlights?nick=ZARA');
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { nick: string }) => r.nick)).toEqual(['zara']);
  });

  it('OR-matches several nicks (repeated from:), case-insensitively', async () => {
    chat('#multinick', 'eren', 'alice ping', 50);
    chat('#multinick', 'nostimo', 'alice ping', 50);
    chat('#multinick', 'stranger', 'alice ping', 50);
    const res = await agent.get('/api/highlights?nick=EREN&nick=nostimo');
    expect(res.status).toBe(200);
    const hits = res.body.items
      .map((r: { nick: string }) => r.nick)
      .filter((n: string) => n === 'eren' || n === 'nostimo' || n === 'stranger')
      .toSorted();
    expect(hits).toEqual(['eren', 'nostimo']);
  });

  it('filters by target (in:)', async () => {
    chat('#in-a', 'mara', 'alice ping', 51);
    chat('#in-b', 'mara', 'alice ping', 51);
    const res = await agent.get('/api/highlights?target=%23in-a');
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { target: string }) => r.target)).toEqual(['#in-a']);
  });

  it('filters by free text (q) over the FTS index', async () => {
    chat('#qf', 'nina', 'needlexyz spotted', 52);
    chat('#qf', 'nina', 'haystack only here', 52);
    const res = await agent.get('/api/highlights?q=needlexyz');
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { text: string }) => r.text)).toEqual(['needlexyz spotted']);
  });

  it('filters by networkId (on:)', async () => {
    const net2 = createNetwork(user.id, {
      name: 'oftc',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'alice',
    })!;
    insertMessage({
      networkId: net2.id,
      target: '#onf',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'pat',
      text: 'alice ping',
      self: false,
      matchedRuleId: 53,
    });
    const res = await agent.get(`/api/highlights?networkId=${net2.id}`);
    expect(res.status).toBe(200);
    expect(res.body.items.every((r: { networkId: number }) => r.networkId === net2.id)).toBe(true);
    expect(res.body.items).toHaveLength(1);
  });
});

describe('GET /api/highlights/reactions', () => {
  // Other people's reactions to the user's own lines, newest reaction first.
  let addReaction: typeof import('../db/reactions.js').addReaction;
  let createUser: typeof import('../db/users.js').createUser;

  beforeAll(async () => {
    ({ addReaction } = await import('../db/reactions.js'));
    ({ createUser } = await import('../db/users.js'));
  });

  function own(target: string, text: string, networkId = net.id): number {
    return Number(
      insertMessage({
        networkId,
        target,
        time: new Date().toISOString(),
        type: 'message',
        nick: 'alice',
        text,
        self: true,
      }).id,
    );
  }

  function react(messageId: number, nick: string, value: string, networkId = net.id) {
    addReaction({
      messageId,
      networkId,
      nick,
      value,
      self: false,
      toSelf: true,
      time: new Date().toISOString(),
    });
  }

  it('requires authentication', async () => {
    const res = await createAnonAgent(app).get('/api/highlights/reactions');
    expect(res.status).toBe(401);
  });

  it('lists reactions to the user’s lines, newest first, and never another user’s', async () => {
    const first = own('#rx', 'first of mine');
    const second = own('#rx', 'second of mine');
    react(first, 'bob', '👍');
    react(second, 'carol', 'lol');

    // Someone else's account, reacted to on their own network.
    const mallory = createUser('hl-mallory');
    const theirs = createNetwork(mallory.id, {
      name: 'theirs',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'mallory',
    })!;
    react(own('#rx', 'not alice’s', theirs.id), 'bob', '🎉', theirs.id);

    const res = await agent.get('/api/highlights/reactions?target=%23rx');
    expect(res.status).toBe(200);
    const items = res.body.items as { id: number; nick: string; value: string; text: string }[];
    expect(items.map((r) => [r.nick, r.value, r.text])).toEqual([
      ['carol', 'lol', 'second of mine'],
      ['bob', '👍', 'first of mine'],
    ]);
    expect(items[1].id).toBe(first);
  });

  it('pages by reaction id', async () => {
    const line = own('#rpage', 'page me');
    react(line, 'p1', '1');
    react(line, 'p2', '2');
    react(line, 'p3', '3');
    const page1 = await agent.get('/api/highlights/reactions?target=%23rpage&limit=2');
    expect(page1.body.items.map((r: { value: string }) => r.value)).toEqual(['3', '2']);
    expect(page1.body.nextBefore).toBe(page1.body.items[1].reactionId);
    const page2 = await agent.get(
      `/api/highlights/reactions?target=%23rpage&limit=2&before=${page1.body.nextBefore}`,
    );
    expect(page2.body.items.map((r: { value: string }) => r.value)).toEqual(['1']);
    expect(page2.body.nextBefore).toBeNull();
  });
});
