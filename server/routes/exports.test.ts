// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent, createAnonAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const ctx = setupTestDb('routes-exports');

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let alice: User;
let bob: User;
let aliceNet: Network;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  const { exportsRouter, importRouter } = await import('./exports.js');

  alice = createUser('exports-alice');
  bob = createUser('exports-bob');
  aliceNet = createNetwork(alice.id, {
    name: 'libera', host: 'irc.libera.chat', port: 6697, tls: true, nick: 'alice',
  })!;
  // Seed messages so the export has something interesting to dump.
  for (let i = 0; i < 3; i += 1) {
    insertMessage({
      networkId: aliceNet.id, target: '#general', time: new Date().toISOString(),
      type: 'message', nick: 'alice', text: `msg ${i}`, self: i % 2 === 0,
    });
  }
  app = createTestApp({ '/api/exports': exportsRouter, '/api/imports': importRouter });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
});

afterAll(() => ctx.cleanup());

describe('GET /api/exports/preview', () => {
  it('requires auth', async () => {
    const res = await createAnonAgent(app).get('/api/exports/preview');
    expect(res.status).toBe(401);
  });

  it('returns row counts for both settings-only and with-messages', async () => {
    const res = await aliceAgent.get('/api/exports/preview');
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('exports-alice');
    expect(typeof res.body.settingsOnly).toBe('object');
    expect(typeof res.body.withMessages).toBe('object');
    // Messages flavor should report >= settings-only by definition.
    const so = (Object.values(res.body.settingsOnly) as number[]).reduce((s, n) => s + n, 0);
    const wm = (Object.values(res.body.withMessages) as number[]).reduce((s, n) => s + n, 0);
    expect(wm).toBeGreaterThanOrEqual(so);
  });
});

describe('GET /api/exports', () => {
  it('streams a non-empty zip', async () => {
    const res = await aliceAgent.get('/api/exports?include_messages=1').buffer(true).parse((stream, cb) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/octet-stream/);
    expect(res.body.length).toBeGreaterThan(50);
    // PK zip signature.
    expect(res.body.slice(0, 2).toString()).toBe('PK');
  });
});

describe('POST /api/imports', () => {
  it('requires a file', async () => {
    const res = await aliceAgent.post('/api/imports');
    expect(res.status).toBe(400);
  });

  it('rejects a non-zip body with code=not_a_zip', async () => {
    const res = await aliceAgent
      .post('/api/imports')
      .attach('archive', Buffer.from('hello not a zip'), { filename: 'fake.lurk' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_a_zip');
  });

  it('refuses import when the account already has data', async () => {
    // Alice has networks → not empty. Export her data then try to re-import.
    const exp = await aliceAgent.get('/api/exports?include_messages=1').buffer(true).parse((stream, cb) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const res = await aliceAgent
      .post('/api/imports')
      .attach('archive', exp.body, { filename: 'export.lurk' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account_not_empty');
  });

  it('round-trips an export into a fresh account', async () => {
    const exp = await aliceAgent.get('/api/exports?include_messages=1').buffer(true).parse((stream, cb) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    // Bob is empty (no networks).
    const res = await bobAgent
      .post('/api/imports')
      .attach('archive', exp.body, { filename: 'alice.lurk' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify Bob now has alice's network and messages.
    const { listNetworksForUser } = await import('../db/networks.js');
    const { listMessages } = await import('../db/messages.js');
    const bobNets = listNetworksForUser(bob.id);
    expect(bobNets.length).toBe(1);
    expect(bobNets[0].name).toBe('libera');
    const bobMsgs = listMessages(bobNets[0].id, '#general', { limit: 100 });
    expect(bobMsgs.length).toBe(3);
  });
});
