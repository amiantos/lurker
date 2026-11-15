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

const ctx = setupTestDb('routes-themes');

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let alice: User;
let bob: User;
let settingsService: typeof import('../services/settingsService.js').default;

// A minimal valid snapshot — a SUBSET of the themed keys is allowed by design
// (missing keys resolve to registry defaults on the client).
const VALUES = { 'look.color.bg': '#101010', 'look.color.fg': '#f0f0f0' };

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./themes.js')).default;
  settingsService = (await import('../services/settingsService.js')).default;

  alice = createUser('themes-alice');
  bob = createUser('themes-bob');
  app = createTestApp({ '/api/themes': router });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
});

afterAll(() => ctx.cleanup());

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await createAnonAgent(app).get('/api/themes');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/themes', () => {
  it('creates a theme and returns it', async () => {
    const res = await aliceAgent.post('/api/themes').send({ name: 'Ocean', values: VALUES });
    expect(res.status).toBe(201);
    expect(res.body.theme.name).toBe('Ocean');
    expect(res.body.theme.values).toEqual(VALUES);
    expect(res.body.theme.id).toBeGreaterThan(0);
  });

  // A tab from before the density keys were renamed snapshots its theme
  // under the old ones.
  it('stores a theme sent under a renamed key under the current one', async () => {
    const res = await aliceAgent
      .post('/api/themes')
      .send({ name: 'Old tab', values: { 'look.message.compact.group_gap': 4 } });
    expect(res.status).toBe(201);
    expect(res.body.theme.values).toEqual({ 'look.message.modern.group_gap': 4 });
    const put = await aliceAgent
      .put(`/api/themes/${res.body.theme.id}`)
      .send({ values: { 'look.message.compact.group_gap': 6 } });
    expect(put.status).toBe(200);
    expect(put.body.theme.values).toEqual({ 'look.message.modern.group_gap': 6 });
    await aliceAgent.delete(`/api/themes/${res.body.theme.id}`);
  });

  it('rejects reserved names, empty names, and over-long names', async () => {
    for (const name of [
      'Dark',
      'light',
      'DEFAULT',
      'Monokai Plus',
      'monokai plus LIGHT',
      '',
      '   ',
      'x'.repeat(41),
    ]) {
      const res = await aliceAgent.post('/api/themes').send({ name, values: VALUES });
      expect(res.status, `name ${JSON.stringify(name)}`).toBe(400);
    }
  });

  it('rejects a duplicate name case-insensitively', async () => {
    const res = await aliceAgent.post('/api/themes').send({ name: 'ocean', values: VALUES });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('rejects non-themed keys and type-invalid values', async () => {
    const nonThemed = await aliceAgent
      .post('/api/themes')
      .send({ name: 'Bad1', values: { 'chat.events': 'smart' } });
    expect(nonThemed.status).toBe(400);
    expect(nonThemed.body.error).toMatch(/not a themed setting/);

    const badType = await aliceAgent
      .post('/api/themes')
      .send({ name: 'Bad2', values: { 'look.font.size': 'huge' } });
    expect(badType.status).toBe(400);

    const empty = await aliceAgent.post('/api/themes').send({ name: 'Bad3', values: {} });
    expect(empty.status).toBe(400);
  });
});

describe('GET /api/themes', () => {
  it("lists only the caller's themes", async () => {
    await bobAgent.post('/api/themes').send({ name: 'Bobs', values: VALUES });
    const res = await aliceAgent.get('/api/themes');
    expect(res.status).toBe(200);
    const names = res.body.items.map((t: { name: string }) => t.name);
    expect(names).toContain('Ocean');
    expect(names).not.toContain('Bobs');
  });
});

describe('PUT /api/themes/:id', () => {
  it('renames and updates values in place', async () => {
    const created = await aliceAgent.post('/api/themes').send({ name: 'Draft', values: VALUES });
    const id = created.body.theme.id;
    const res = await aliceAgent
      .put(`/api/themes/${id}`)
      .send({ name: 'Final', values: { 'look.color.bg': '#202020' } });
    expect(res.status).toBe(200);
    expect(res.body.theme.name).toBe('Final');
    expect(res.body.theme.values).toEqual({ 'look.color.bg': '#202020' });
  });

  it('allows a rename to a different casing of itself', async () => {
    const created = await aliceAgent.post('/api/themes').send({ name: 'Casing', values: VALUES });
    const res = await aliceAgent
      .put(`/api/themes/${created.body.theme.id}`)
      .send({ name: 'CASING' });
    expect(res.status).toBe(200);
    expect(res.body.theme.name).toBe('CASING');
  });

  it("404s on another user's theme and on unknown ids", async () => {
    const created = await aliceAgent.post('/api/themes').send({ name: 'Mine', values: VALUES });
    const res = await bobAgent.put(`/api/themes/${created.body.theme.id}`).send({ name: 'Stolen' });
    expect(res.status).toBe(404);
    const gone = await aliceAgent.put('/api/themes/999999').send({ name: 'Ghost' });
    expect(gone.status).toBe(404);
  });
});

describe('DELETE /api/themes/:id', () => {
  it('deletes a theme (and 404s for the other user)', async () => {
    const created = await aliceAgent.post('/api/themes').send({ name: 'Doomed', values: VALUES });
    const id = created.body.theme.id;
    const denied = await bobAgent.delete(`/api/themes/${id}`);
    expect(denied.status).toBe(404);
    const res = await aliceAgent.delete(`/api/themes/${id}`);
    expect(res.status).toBe(200);
    const list = await aliceAgent.get('/api/themes');
    expect(list.body.items.map((t: { id: number }) => t.id)).not.toContain(id);
  });

  it('resets any look.theme.* pointer aimed at the deleted theme', async () => {
    const created = await aliceAgent.post('/api/themes').send({ name: 'Pointed', values: VALUES });
    const id = created.body.theme.id;
    settingsService.update(alice.id, {
      'look.theme.active': String(id),
      'look.theme.dark': String(id),
      // Non-default so the row persists (the default value would auto-drop);
      // must SURVIVE the deletion — it doesn't point at the doomed theme.
      'look.theme.light': 'dark',
    });
    await aliceAgent.delete(`/api/themes/${id}`);
    const after = settingsService.update(alice.id, {});
    // Dangling pointers reset to their defaults; the untouched one survives.
    expect(after.ok && after.values['look.theme.active']).toBeUndefined();
    expect(after.ok && after.values['look.theme.dark']).toBeUndefined();
    expect(after.ok && after.values['look.theme.light']).toBe('dark');
  });
});
