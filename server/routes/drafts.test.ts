// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import { setupTestDb, createTestApp, createAuthedAgent, createAnonAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';

const ctx = setupTestDb('routes-drafts');

let app: Express;
let aliceAgent: LurkerTestAgent;
let alice: User;
let bob: User;
let aliceNet: Network;
let bobNet: Network;
let listForUser: typeof import('../db/drafts.js').listForUser;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ listForUser } = await import('../db/drafts.js'));
  const router = (await import('./drafts.js')).default;

  alice = createUser('drafts-alice');
  bob = createUser('drafts-bob');
  aliceNet = createNetwork(alice.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'alice' })!;
  bobNet = createNetwork(bob.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'bob' })!;

  app = createTestApp({ '/api/drafts': router });
  aliceAgent = await createAuthedAgent(app, alice.id);
});

afterAll(() => ctx.cleanup());

describe('POST /api/drafts/flush', () => {
  it('requires auth', async () => {
    const res = await createAnonAgent(app)
      .post('/api/drafts/flush')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ drafts: [] }));
    expect(res.status).toBe(401);
  });

  it('persists drafts from a beacon-shaped text/plain body', async () => {
    const payload = JSON.stringify({
      drafts: [
        { networkId: aliceNet.id, target: '#meta', body: 'half-typed reply' },
        { networkId: aliceNet.id, target: 'bob', body: 'dm in progress' },
      ],
    });
    const res = await aliceAgent
      .post('/api/drafts/flush')
      .set('Content-Type', 'text/plain')
      .send(payload);
    expect(res.status).toBe(204);
    const rows = listForUser(alice.id);
    const byTarget = new Map(rows.map((r) => [r.target, r.body]));
    expect(byTarget.get('#meta')).toBe('half-typed reply');
    expect(byTarget.get('bob')).toBe('dm in progress');
  });

  it('an empty body clears the existing draft (sparse-row contract)', async () => {
    await aliceAgent
      .post('/api/drafts/flush')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ drafts: [{ networkId: aliceNet.id, target: '#clear-me', body: 'tmp' }] }));
    expect(listForUser(alice.id).some((r) => r.target === '#clear-me')).toBe(true);
    await aliceAgent
      .post('/api/drafts/flush')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ drafts: [{ networkId: aliceNet.id, target: '#clear-me', body: '' }] }));
    expect(listForUser(alice.id).some((r) => r.target === '#clear-me')).toBe(false);
  });

  it('silently skips entries that point at another user\'s network', async () => {
    await aliceAgent
      .post('/api/drafts/flush')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({
        drafts: [
          { networkId: bobNet.id, target: '#nope', body: 'should not save' },
          { networkId: aliceNet.id, target: '#ok', body: 'should save' },
        ],
      }));
    const aliceRows = listForUser(alice.id);
    expect(aliceRows.some((r) => r.target === '#nope')).toBe(false);
    expect(aliceRows.some((r) => r.target === '#ok')).toBe(true);
    expect(listForUser(bob.id)).toEqual([]);
  });

  it('silently skips :server:-prefixed pseudo-targets', async () => {
    await aliceAgent
      .post('/api/drafts/flush')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({
        drafts: [{ networkId: aliceNet.id, target: ':server:libera', body: 'pseudo' }],
      }));
    expect(listForUser(alice.id).some((r) => r.target === ':server:libera')).toBe(false);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await aliceAgent
      .post('/api/drafts/flush')
      .set('Content-Type', 'text/plain')
      .send('this is not json');
    expect(res.status).toBe(400);
  });

  it('accepts an empty body as a no-op', async () => {
    // sendBeacon may fire with no payload at all on tab-close races.
    const res = await aliceAgent
      .post('/api/drafts/flush')
      .set('Content-Type', 'text/plain')
      .send('');
    expect(res.status).toBe(204);
  });
});
