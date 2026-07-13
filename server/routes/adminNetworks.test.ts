// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The admin half of instance network management (#298): the presets this
// instance recommends, and the lockdown switch. The *enforcement* of that switch
// lives with the routes that enforce it (routes/networks.test.ts) and with the
// predicate itself (services/networkPolicy.test.ts) — same split as the uploader
// suite. What's tested here is the policy write and its guard rails.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-admin-networks');

let app: Express;
let adminAgent: LurkerTestAgent;
let userAgent: LurkerTestAgent;
let admin: User;
let plainUser: User;
let db: typeof import('../db/index.js').default;
let allowUserDefinedNetworks: typeof import('../db/instanceSettings.js').allowUserDefinedNetworks;
let setAllowUserDefinedNetworks: typeof import('../db/instanceSettings.js').setAllowUserDefinedNetworks;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./admin.js')).default;
  db = (await import('../db/index.js')).default;
  ({ allowUserDefinedNetworks, setAllowUserDefinedNetworks } =
    await import('../db/instanceSettings.js'));

  admin = createUser('adminnet-root', { role: 'admin' });
  plainUser = createUser('adminnet-nobody');

  app = createTestApp({ '/api/admin': router });
  adminAgent = await createAuthedAgent(app, admin.id);
  userAgent = await createAuthedAgent(app, plainUser.id);
});

afterAll(() => ctx.cleanup());

beforeEach(() => {
  db.prepare('DELETE FROM instance_network').run();
  setAllowUserDefinedNetworks(true);
});

function add(fields: Record<string, unknown> = {}) {
  return adminAgent
    .post('/api/admin/networks')
    .send({ name: 'Corp', host: 'irc.corp.example', ...fields });
}

describe('auth', () => {
  it('refuses a non-admin', async () => {
    expect((await userAgent.get('/api/admin/networks')).status).toBe(403);
    expect(
      (await userAgent.post('/api/admin/networks').send({ name: 'x', host: 'h' })).status,
    ).toBe(403);
    expect(
      (await userAgent.put('/api/admin/networks/policy').send({ allowUserDefined: false })).status,
    ).toBe(403);
  });
});

describe('presets', () => {
  it('creates one with sensible defaults', async () => {
    const res = await add();
    expect(res.status).toBe(201);
    expect(res.body.preset).toMatchObject({
      name: 'Corp',
      host: 'irc.corp.example',
      port: 6697,
      tls: true,
      saslLikelyRequired: false,
      enabled: true,
      channels: [],
    });
  });

  it('requires a name and a host', async () => {
    expect((await adminAgent.post('/api/admin/networks').send({ name: 'Corp' })).status).toBe(400);
    expect((await adminAgent.post('/api/admin/networks').send({ host: 'h' })).status).toBe(400);
  });

  it('rejects a nonsense port', async () => {
    expect((await add({ port: 99999 })).status).toBe(400);
    expect((await add({ port: 'ssl' })).status).toBe(400);
  });

  // The pane sends an array; an admin with curl will reach for the same
  // comma-separated string the rest of the API takes for channels.
  it('accepts recommended channels as an array or a string, de-duplicated', async () => {
    const arr = await add({ channels: ['#general', '#random'] });
    expect(arr.body.preset.channels).toStrictEqual(['#general', '#random']);

    const str = await add({ host: 'irc.two.example', channels: '#general, #General  #ops' });
    expect(str.body.preset.channels).toStrictEqual(['#general', '#ops']);
  });

  it('updates and deletes', async () => {
    const created = await add();
    const id = created.body.preset.id;

    const patched = await adminAgent
      .patch(`/api/admin/networks/${id}`)
      .send({ name: 'Renamed', enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.preset).toMatchObject({ name: 'Renamed', enabled: false });
    // A partial patch must not blank the fields it didn't mention.
    expect(patched.body.preset.host).toBe('irc.corp.example');

    expect((await adminAgent.delete(`/api/admin/networks/${id}`)).status).toBe(200);
    expect((await adminAgent.get('/api/admin/networks')).body.presets).toStrictEqual([]);
  });

  // A partial patch trims its strings, so without an explicit non-empty check a
  // whitespace-only host trims to '' and gets written — leaving a preset that
  // names no server and, under lockdown, authorizes nothing.
  it('refuses to blank a name or host via patch', async () => {
    const created = await add();
    const id = created.body.preset.id;

    expect((await adminAgent.patch(`/api/admin/networks/${id}`).send({ host: '   ' })).status).toBe(
      400,
    );
    expect((await adminAgent.patch(`/api/admin/networks/${id}`).send({ name: '' })).status).toBe(
      400,
    );

    const still = await adminAgent.get('/api/admin/networks');
    expect(still.body.presets[0]).toMatchObject({ name: 'Corp', host: 'irc.corp.example' });
  });

  it('404s on an unknown id', async () => {
    expect((await adminAgent.patch('/api/admin/networks/9999').send({ name: 'x' })).status).toBe(
      404,
    );
    expect((await adminAgent.delete('/api/admin/networks/9999')).status).toBe(404);
  });

  it('lists disabled presets to the admin', async () => {
    await add({ enabled: false });
    const res = await adminAgent.get('/api/admin/networks');
    expect(res.body.presets).toHaveLength(1);
    expect(res.body.presets[0].enabled).toBe(false);
  });
});

describe('the lockdown switch', () => {
  it('flips', async () => {
    await add();
    const res = await adminAgent
      .put('/api/admin/networks/policy')
      .send({ allowUserDefined: false });
    expect(res.status).toBe(200);
    expect(allowUserDefinedNetworks()).toBe(false);
  });

  it('rejects a non-boolean', async () => {
    expect((await adminAgent.put('/api/admin/networks/policy').send({})).status).toBe(400);
  });

  // Locking down with nothing on the list would leave every user — the admin
  // very much included — unable to connect to anything at all.
  it('refuses to lock down when there is nothing to lock down TO', async () => {
    const res = await adminAgent
      .put('/api/admin/networks/policy')
      .send({ allowUserDefined: false });
    expect(res.status).toBe(409);
    expect(allowUserDefinedNetworks()).toBe(true);
  });

  it('does not count a disabled preset as something to lock down to', async () => {
    await add({ enabled: false });
    const res = await adminAgent
      .put('/api/admin/networks/policy')
      .send({ allowUserDefined: false });
    expect(res.status).toBe(409);
  });

  // Same trap from the other direction: delete your way down to nothing while
  // locked down, and the instance quietly becomes unusable.
  it('refuses to delete the last usable preset while locked down', async () => {
    const created = await add();
    await adminAgent.put('/api/admin/networks/policy').send({ allowUserDefined: false });

    const res = await adminAgent.delete(`/api/admin/networks/${created.body.preset.id}`);
    expect(res.status).toBe(409);
    expect((await adminAgent.get('/api/admin/networks')).body.presets).toHaveLength(1);
  });

  // The same hole as the delete guard, through a different door: un-offering the
  // only preset empties the allowed set just as thoroughly as deleting it, and
  // leaves the whole instance — the admin too — unable to connect to anything.
  it('refuses to un-offer the last usable preset while locked down', async () => {
    const created = await add();
    await adminAgent.put('/api/admin/networks/policy').send({ allowUserDefined: false });

    const res = await adminAgent
      .patch(`/api/admin/networks/${created.body.preset.id}`)
      .send({ enabled: false });
    expect(res.status).toBe(409);
    expect((await adminAgent.get('/api/admin/networks')).body.presets[0].enabled).toBe(true);
  });

  it('allows un-offering one of several while locked down', async () => {
    const first = await add();
    await add({ host: 'irc.two.example' });
    await adminAgent.put('/api/admin/networks/policy').send({ allowUserDefined: false });

    const res = await adminAgent
      .patch(`/api/admin/networks/${first.body.preset.id}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
  });

  it('allows deleting one of several while locked down', async () => {
    const first = await add();
    await add({ host: 'irc.two.example' });
    await adminAgent.put('/api/admin/networks/policy').send({ allowUserDefined: false });

    expect((await adminAgent.delete(`/api/admin/networks/${first.body.preset.id}`)).status).toBe(
      200,
    );
  });

  it('allows deleting the last one once the lockdown is lifted', async () => {
    const created = await add();
    await adminAgent.put('/api/admin/networks/policy').send({ allowUserDefined: false });
    await adminAgent.put('/api/admin/networks/policy').send({ allowUserDefined: true });

    expect((await adminAgent.delete(`/api/admin/networks/${created.body.preset.id}`)).status).toBe(
      200,
    );
  });
});
