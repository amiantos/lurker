// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The admin half of uploader management (#514 / #299): instance uploaders, the
// default a new account inherits, and the lockdown switch.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-admin-uploaders');

let app: Express;
let adminAgent: LurkerTestAgent;
let userAgent: LurkerTestAgent;
let admin: User;
let plainUser: User;
let listInstanceUploaders: typeof import('../db/uploaderConfig.js').listInstanceUploaders;
let getUploaderConfig: typeof import('../db/uploaderConfig.js').getUploaderConfig;
let allowUserDefinedUploaders: typeof import('../db/instanceSettings.js').allowUserDefinedUploaders;
let setAllowUserDefinedUploaders: typeof import('../db/instanceSettings.js').setAllowUserDefinedUploaders;
let resolveUploader: typeof import('../services/uploadProviders/resolve.js').resolveUploader;

const instanceRow = (driver: string) => listInstanceUploaders().find((r) => r.driver === driver)!;

let db: typeof import('../db/index.js').default;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./admin.js')).default;
  db = (await import('../db/index.js')).default;
  ({ listInstanceUploaders, getUploaderConfig } = await import('../db/uploaderConfig.js'));
  ({ allowUserDefinedUploaders, setAllowUserDefinedUploaders } =
    await import('../db/instanceSettings.js'));
  ({ resolveUploader } = await import('../services/uploadProviders/resolve.js'));

  admin = createUser('adminup-root', { role: 'admin' });
  plainUser = createUser('adminup-nobody');

  app = createTestApp({ '/api/admin': router });
  adminAgent = await createAuthedAgent(app, admin.id);
  userAgent = await createAuthedAgent(app, plainUser.id);
});

afterAll(() => ctx.cleanup());

beforeEach(() => {
  // Drop anything a previous test stood up; the seeded built-ins stay.
  db.prepare(
    `DELETE FROM uploader_config
      WHERE scope = 'instance' AND driver NOT IN ('x0','catbox','local')`,
  ).run();
  db.prepare(`DELETE FROM uploader_config WHERE scope = 'user'`).run();
  setAllowUserDefinedUploaders(true);
});

describe('auth', () => {
  it('403s a non-admin', async () => {
    expect((await userAgent.get('/api/admin/uploaders')).status).toBe(403);
    expect(
      (await userAgent.put('/api/admin/uploaders/policy').send({ allowUserDefined: false })).status,
    ).toBe(403);
  });
});

describe('GET /api/admin/uploaders', () => {
  it('lists the instance uploaders with their policy flags', async () => {
    const res = await adminAgent.get('/api/admin/uploaders');
    expect(res.status).toBe(200);

    const x0 = res.body.uploaders.find((u: any) => u.driver === 'x0');
    expect(x0.isDefault).toBe(true);
    expect(x0.offeredToUsers).toBe(true);
    expect(x0.builtIn).toBe(true);
    expect(res.body.allowUserDefined).toBe(true);
  });

  it('never projects a LOCKED row’s config (the hosted operator’s endpoint)', async () => {
    // The hosted default is seeded from the operator env and re-derived every
    // boot. A cell tenant holding the admin role has no business reading its
    // endpoint, and nothing can edit it anyway (PATCH 409s).
    const { createUploaderConfig } = await import('../db/uploaderConfig.js');
    createUploaderConfig({
      scope: 'instance',
      driver: 'hoarder',
      label: 'Hosted uploader',
      values: { url: 'https://internal-dropper.lurker.chat', api_key: 'operator-key' },
      locked: true,
    });

    const res = await adminAgent.get('/api/admin/uploaders');
    const locked = res.body.uploaders.find((u: any) => u.locked);
    expect(locked.label).toBe('Hosted uploader'); // still nameable…
    expect(locked.config).toEqual({}); // …but opaque
    expect(locked.secretsSet).toEqual({});
    expect(JSON.stringify(res.body)).not.toContain('internal-dropper');
    expect(JSON.stringify(res.body)).not.toContain('operator-key');
  });

  it('marks the seeded rows built-in — including catbox, which is ALSO user-creatable', async () => {
    const res = await adminAgent.get('/api/admin/uploaders');
    const byDriver = Object.fromEntries(res.body.uploaders.map((u: any) => [u.driver, u]));
    // The distinction that matters: "may a user instantiate this driver" and "is
    // this row one the boot reconcile will put back" are different questions.
    expect(byDriver.catbox.builtIn).toBe(true);
    expect(res.body.drivers.map((d: any) => d.driver)).toContain('catbox');
  });
});

describe('creating and configuring an instance uploader', () => {
  it('creates one, keeps the secret server-side, and offers it to users', async () => {
    const res = await adminAgent.post('/api/admin/uploaders').send({
      driver: 's3',
      label: 'Company R2',
      values: {
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        bucket: 'uploads',
        access_key_id: 'AKIA',
        secret_access_key: 'super-secret',
        public_base_url: 'https://cdn.example.com',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Company R2');
    expect(res.body.offeredToUsers).toBe(true);
    expect(res.body.config.bucket).toBe('uploads');
    expect(res.body.secretsSet).toEqual({ secret_access_key: true });
    expect(JSON.stringify(res.body)).not.toContain('super-secret');

    const { resolvedConfig } = await import('../db/uploaderConfig.js');
    expect(resolvedConfig(getUploaderConfig(res.body.id)!).secret_access_key).toBe('super-secret');
  });

  it('rejects an incomplete config', async () => {
    const res = await adminAgent
      .post('/api/admin/uploaders')
      .send({ driver: 's3', values: { bucket: 'only-this' } });
    expect(res.status).toBe(400);
  });

  it('toggles offered_to_users, which adds/removes it from a user’s allowed set', async () => {
    const created = (
      await adminAgent
        .post('/api/admin/uploaders')
        .send({ driver: 'zipline', values: { url: 'https://z.example', token: 't' } })
    ).body;

    const { listAllowedUploaders } = await import('../services/uploadProviders/resolve.js');
    expect(listAllowedUploaders(plainUser.id).map((r) => r.id)).toContain(created.id);

    await adminAgent.patch(`/api/admin/uploaders/${created.id}`).send({ offeredToUsers: false });
    expect(listAllowedUploaders(plainUser.id).map((r) => r.id)).not.toContain(created.id);
    // …but an admin still sees it.
    expect(listAllowedUploaders(admin.id, true).map((r) => r.id)).toContain(created.id);
  });
});

describe('the instance default (#299)', () => {
  it('moves the default, and a user who has not chosen follows it', async () => {
    // A brand-new account has no selection, so it resolves to the instance default.
    expect(resolveUploader({ userId: plainUser.id }).driverId).toBe('x0');

    const local = instanceRow('local');
    const res = await adminAgent.put(`/api/admin/uploaders/${local.id}/default`);
    expect(res.status).toBe(200);

    expect(resolveUploader({ userId: plainUser.id }).driverId).toBe('local');
    // Exactly one default survives the swap (the unique partial index depends on it).
    expect(listInstanceUploaders().filter((r) => r.is_default === 1)).toHaveLength(1);

    await adminAgent.put(`/api/admin/uploaders/${instanceRow('x0').id}/default`); // restore
  });

  it('refuses to make a disabled uploader the default', async () => {
    const catbox = instanceRow('catbox');
    await adminAgent.patch(`/api/admin/uploaders/${catbox.id}`).send({ enabled: false });

    const res = await adminAgent.put(`/api/admin/uploaders/${catbox.id}/default`);
    expect(res.status).toBe(409);

    await adminAgent.patch(`/api/admin/uploaders/${catbox.id}`).send({ enabled: true });
  });

  // The default is reached WITHOUT going through the allowed-set check (being
  // offered to you is the whole point of a default), so a disabled one would
  // otherwise keep quietly serving every account that never picked an uploader.
  it('refuses to DISABLE the current default', async () => {
    const x0 = instanceRow('x0');
    const res = await adminAgent.patch(`/api/admin/uploaders/${x0.id}`).send({ enabled: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/another default/);
    expect(getUploaderConfig(x0.id)!.enabled).toBe(1);
  });

  it('a default that somehow ends up disabled resolves to nothing, not to itself', async () => {
    // Belt and braces: the route above blocks the obvious path, but the resolver
    // must not trust the flag either — a disabled row is not a usable uploader,
    // and "no usable uploader" is the honest answer (decision 15).
    const { updateUploaderConfig } = await import('../db/uploaderConfig.js');
    const x0 = instanceRow('x0');
    updateUploaderConfig(x0.id, { enabled: false }); // bypass the route guard

    const { UploaderUnavailableError } = await import('../services/uploadProviders/resolve.js');
    expect(() => resolveUploader({ userId: plainUser.id })).toThrow(UploaderUnavailableError);

    updateUploaderConfig(x0.id, { enabled: true });
  });
});

describe('DELETE /api/admin/uploaders/:id', () => {
  it('refuses to delete a built-in (it would just come back on the next boot)', async () => {
    for (const driver of ['x0', 'catbox', 'local']) {
      const res = await adminAgent.delete(`/api/admin/uploaders/${instanceRow(driver).id}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/built-in/);
    }
    expect(listInstanceUploaders()).toHaveLength(3);
  });

  it('refuses to delete the current default', async () => {
    const created = (
      await adminAgent
        .post('/api/admin/uploaders')
        .send({ driver: 'zipline', values: { url: 'https://z.example', token: 't' } })
    ).body;
    await adminAgent.put(`/api/admin/uploaders/${created.id}/default`);

    const res = await adminAgent.delete(`/api/admin/uploaders/${created.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/another default/);

    await adminAgent.put(`/api/admin/uploaders/${instanceRow('x0').id}/default`);
  });

  it('deletes one the admin created', async () => {
    const created = (
      await adminAgent
        .post('/api/admin/uploaders')
        .send({ driver: 'chibisafe', values: { url: 'https://c.example', api_key: 'k' } })
    ).body;

    expect((await adminAgent.delete(`/api/admin/uploaders/${created.id}`)).status).toBe(200);
    expect(getUploaderConfig(created.id)).toBeNull();
  });
});

describe('PUT /api/admin/uploaders/policy', () => {
  it('flips the lockdown switch', async () => {
    const res = await adminAgent
      .put('/api/admin/uploaders/policy')
      .send({ allowUserDefined: false });
    expect(res.status).toBe(200);
    expect(allowUserDefinedUploaders()).toBe(false);
  });

  it('locking down does NOT disable the uploaders people already have', async () => {
    // §10's open decision, resolved: don't strand a self-hoster who flips the
    // switch — they just can't add NEW ones.
    const { createUploaderConfig } = await import('../db/uploaderConfig.js');
    const mine = createUploaderConfig({
      scope: 'user',
      ownerUserId: plainUser.id,
      driver: 'catbox',
      values: { userhash: 'h' },
    });

    await adminAgent.put('/api/admin/uploaders/policy').send({ allowUserDefined: false });

    const { listAllowedUploaders } = await import('../services/uploadProviders/resolve.js');
    expect(listAllowedUploaders(plainUser.id).map((r) => r.id)).toContain(mine);
    expect(getUploaderConfig(mine)!.enabled).toBe(1);
  });

  it('rejects a non-boolean', async () => {
    expect(
      (await adminAgent.put('/api/admin/uploaders/policy').send({ allowUserDefined: 'yes' }))
        .status,
    ).toBe(400);
  });
});
