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

const ctx = setupTestDb('routes-aliases');

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let alice: User;
let bob: User;
let changes: number[];

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./aliases.js')).default;
  const service = (await import('../services/aliasesService.js')).default;

  alice = createUser('aliases-alice');
  bob = createUser('aliases-bob');
  app = createTestApp({ '/api/aliases': router });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
  changes = [];
  service.on('change', ({ userId }: { userId: number }) => changes.push(userId));
});

afterAll(() => ctx.cleanup());

const names = async (agent: LurkerTestAgent): Promise<string[]> =>
  (await agent.get('/api/aliases')).body.aliases.map((a: { name: string }) => a.name);

describe('GET /api/aliases', () => {
  it('requires auth', async () => {
    const res = await createAnonAgent(app).get('/api/aliases');
    expect(res.status).toBe(401);
  });

  it('starts empty', async () => {
    expect((await aliceAgent.get('/api/aliases')).body).toEqual({ aliases: [] });
  });
});

describe('PUT /api/aliases/:name', () => {
  it('defines an alias, stored without its slash or its case', async () => {
    const res = await aliceAgent.put('/api/aliases/WII').send({ body: '  /whois $1 $1 ' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ alias: { name: 'wii', body: '/whois $1 $1' }, created: true });
    expect(changes).toContain(alice.id);
  });

  it('replaces the one of that name', async () => {
    const res = await aliceAgent.put('/api/aliases/wii').send({ body: '/whois $1' });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    const list = await aliceAgent.get('/api/aliases');
    expect(list.body.aliases).toEqual([{ name: 'wii', body: '/whois $1' }]);
  });

  it('takes the name of a built-in command', async () => {
    const res = await aliceAgent.put('/api/aliases/msg').send({ body: '/notice $1 $2-' });
    expect(res.status).toBe(201);
  });

  it('refuses /alias and /unalias', async () => {
    for (const name of ['alias', 'unalias']) {
      const res = await aliceAgent.put(`/api/aliases/${name}`).send({ body: '/quit' });
      expect(res.status).toBe(400);
    }
  });

  it('refuses a name with a space, and a body with no command', async () => {
    expect((await aliceAgent.put('/api/aliases/a%20b').send({ body: '/quit' })).status).toBe(400);
    expect((await aliceAgent.put('/api/aliases/x').send({ body: ' ; ' })).status).toBe(400);
    expect((await aliceAgent.put('/api/aliases/x').send({})).status).toBe(400);
  });

  it('keeps each user to their own', async () => {
    await bobAgent.put('/api/aliases/j').send({ body: '/join' });
    expect(await names(bobAgent)).toEqual(['j']);
    expect(await names(aliceAgent)).toEqual(['msg', 'wii']);
  });
});

describe('PATCH /api/aliases/:name', () => {
  it('rewrites the body', async () => {
    const res = await aliceAgent.patch('/api/aliases/wii').send({ body: '/whois $1 $1' });
    expect(res.body.alias).toEqual({ name: 'wii', body: '/whois $1 $1' });
  });

  it('renames, keeping the body', async () => {
    const res = await aliceAgent.patch('/api/aliases/wii').send({ name: '/Who2' });
    expect(res.body.alias).toEqual({ name: 'who2', body: '/whois $1 $1' });
    expect(await names(aliceAgent)).toEqual(['msg', 'who2']);
  });

  it('refuses a rename onto a name in use, and changes nothing', async () => {
    const res = await aliceAgent.patch('/api/aliases/who2').send({ name: 'msg', body: '/quit' });
    expect(res.status).toBe(409);
    const list = await aliceAgent.get('/api/aliases');
    expect(list.body.aliases).toEqual([
      { name: 'msg', body: '/notice $1 $2-' },
      { name: 'who2', body: '/whois $1 $1' },
    ]);
  });

  it('is a 404 for an alias that is not there, or is someone else’s', async () => {
    expect((await aliceAgent.patch('/api/aliases/nope').send({ body: '/quit' })).status).toBe(404);
    expect((await aliceAgent.patch('/api/aliases/j').send({ body: '/quit' })).status).toBe(404);
    expect((await bobAgent.get('/api/aliases')).body.aliases).toEqual([
      { name: 'j', body: '/join' },
    ]);
  });
});

describe('DELETE /api/aliases/:name', () => {
  it('removes one', async () => {
    expect((await aliceAgent.delete('/api/aliases/WHO2')).status).toBe(200);
    expect(await names(aliceAgent)).toEqual(['msg']);
  });

  it('is a 404 the second time, and for someone else’s', async () => {
    expect((await aliceAgent.delete('/api/aliases/who2')).status).toBe(404);
    expect((await aliceAgent.delete('/api/aliases/j')).status).toBe(404);
    expect(await names(bobAgent)).toEqual(['j']);
  });
});

describe('a row that breaks the naming rules', () => {
  // An archive import inserts rows as they are, and a name can become reserved
  // after someone took it. Such a row must still be editable and removable.
  const plant = async (name: string) => {
    const db = (await import('../db/index.js')).default;
    db.prepare('INSERT INTO user_aliases (user_id, name, body) VALUES (?, ?, ?)').run(
      alice.id,
      name,
      '/quit',
    );
  };

  it('can be removed', async () => {
    await plant('alias');
    await plant('Two Words');
    expect((await aliceAgent.delete('/api/aliases/alias')).status).toBe(200);
    expect((await aliceAgent.delete('/api/aliases/Two%20Words')).status).toBe(200);
    expect(await names(aliceAgent)).toEqual(['msg']);
  });

  it('can be renamed to a name that keeps them', async () => {
    await plant('unalias');
    const res = await aliceAgent.patch('/api/aliases/unalias').send({ name: 'bye' });
    expect(res.body.alias).toEqual({ name: 'bye', body: '/quit' });
  });
});
