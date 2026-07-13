// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The user-facing uploader API (#514). The load-bearing property under test —
// the one the whole design hangs on — is that a SECRET NEVER COMES BACK. Every
// projection assertion here is really asserting that.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  testRequest,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-uploaders');

let app: Express;
let agent: LurkerTestAgent;
let intruderAgent: LurkerTestAgent;
let user: User;
let intruder: User;
let setAllowUserDefinedUploaders: typeof import('../db/instanceSettings.js').setAllowUserDefinedUploaders;
let getUploaderConfig: typeof import('../db/uploaderConfig.js').getUploaderConfig;
let listInstanceUploaders: typeof import('../db/uploaderConfig.js').listInstanceUploaders;
let resolveUploader: typeof import('../services/uploadProviders/resolve.js').resolveUploader;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./uploaders.js')).default;
  ({ setAllowUserDefinedUploaders } = await import('../db/instanceSettings.js'));
  ({ getUploaderConfig, listInstanceUploaders } = await import('../db/uploaderConfig.js'));
  ({ resolveUploader } = await import('../services/uploadProviders/resolve.js'));

  user = createUser('uploaders-alice');
  intruder = createUser('uploaders-mallory');
  app = createTestApp({ '/api/uploaders': router });
  agent = await createAuthedAgent(app, user.id);
  intruderAgent = await createAuthedAgent(app, intruder.id);
});

afterAll(() => ctx.cleanup());

async function createCatbox(hash = 'my-userhash') {
  const res = await agent.post('/api/uploaders').send({
    driver: 'catbox',
    label: 'My catbox',
    values: { userhash: hash },
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe('GET /api/uploaders', () => {
  it('401 without a session', async () => {
    expect((await testRequest(app).get('/api/uploaders')).status).toBe(401);
  });

  it('lists the seeded instance uploaders, and flags which drivers may be ADDED', async () => {
    const res = await agent.get('/api/uploaders');
    expect(res.status).toBe(200);
    expect(res.body.uploaders.map((u: any) => u.driver)).toEqual(
      expect.arrayContaining(['x0', 'catbox', 'local']),
    );
    // The "add an uploader" menu is the `creatable` subset — NOT the whole list
    // (see the migrated-hoarder case below for why the list is the whole set).
    // x0 and local are zero-config singletons; hoarder is the seed-managed dropper.
    const creatable = res.body.drivers.filter((d: any) => d.creatable).map((d: any) => d.driver);
    expect(creatable).toEqual(expect.arrayContaining(['catbox', 'zipline', 'chibisafe', 's3']));
    expect(creatable).not.toContain('x0');
    expect(creatable).not.toContain('local');
    expect(creatable).not.toContain('hoarder');
    expect(res.body.selectedId).toBeNull();
  });

  // The user reconcileLegacyUploadSettings rescues owns a `hoarder` row: editable,
  // but NOT creatable. If the driver list only carried creatable drivers, the
  // client would have no schema to render their edit form from — and the pane blew
  // up on it. The people this release exists to rescue are exactly the people who
  // must not hit a wall here.
  it('describes EVERY driver an owned row can reference, not just the creatable ones', async () => {
    const { createUploaderConfig } = await import('../db/uploaderConfig.js');
    const migrated = createUploaderConfig({
      scope: 'user',
      ownerUserId: user.id,
      driver: 'dropper', // what the legacy-settings migration produces
      label: 'Hoarder',
      values: { url: 'https://hoard.example', api_key: 'k' },
    });

    const res = await agent.get('/api/uploaders');
    const row = res.body.uploaders.find((u: any) => u.id === migrated);
    expect(row.editable).toBe(true);

    // …so a descriptor for its driver MUST be present, or the form can't render.
    const dropper = res.body.drivers.find((d: any) => d.driver === 'dropper');
    expect(dropper).toBeDefined();
    expect(dropper.creatable).toBe(false); // but still not offered in the add menu
    expect(dropper.configSchema.map((f: any) => f.key)).toEqual(['url', 'api_key']);

    // And editing it still works end-to-end, secret preserved on omit.
    const patched = await agent.patch(`/api/uploaders/${migrated}`).send({ label: 'My Hoarder' });
    expect(patched.status).toBe(200);
    const { resolvedConfig } = await import('../db/uploaderConfig.js');
    expect(resolvedConfig(getUploaderConfig(migrated)!).api_key).toBe('k');
  });

  it('serves each driver’s own configSchema (the form is the driver’s, not the client’s)', async () => {
    const res = await agent.get('/api/uploaders');
    const s3 = res.body.drivers.find((d: any) => d.driver === 's3');
    expect(s3.configSchema.map((f: any) => f.key)).toContain('secret_access_key');
    const secret = s3.configSchema.find((f: any) => f.key === 'secret_access_key');
    expect(secret.type).toBe('secret');
    expect(secret.required).toBe(true);
  });

  it('an instance uploader is a name to pick, not a config to read', async () => {
    const res = await agent.get('/api/uploaders');
    const x0 = res.body.uploaders.find((u: any) => u.driver === 'x0');
    expect(x0.editable).toBe(false);
    // No config/secretsSet projected for rows the caller doesn't own.
    expect(x0.config).toBeUndefined();
    expect(x0.secretsSet).toBeUndefined();
  });
});

describe('POST /api/uploaders', () => {
  it('creates a personal uploader and NEVER echoes the secret back', async () => {
    const body = await createCatbox('sekrit-hash');

    expect(body.driver).toBe('catbox');
    expect(body.label).toBe('My catbox');
    expect(body.scope).toBe('user');
    expect(body.editable).toBe(true);
    // The whole contract in two lines: we're told a secret is SET, never what it is.
    expect(body.secretsSet).toEqual({ userhash: true });
    expect(JSON.stringify(body)).not.toContain('sekrit-hash');

    // …but the server still has it, and hands it to the driver at upload time.
    const row = getUploaderConfig(body.id)!;
    expect(row.config_json).not.toContain('sekrit-hash'); // secrets never in config_json
    const { resolvedConfig } = await import('../db/uploaderConfig.js');
    expect(resolvedConfig(row).userhash).toBe('sekrit-hash');
  });

  it('rejects a missing required field', async () => {
    const res = await agent
      .post('/api/uploaders')
      .send({ driver: 'zipline', values: { url: 'https://z.example' } }); // no token
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
  });

  it('rejects an unknown config field (the schema is the allowlist)', async () => {
    const res = await agent
      .post('/api/uploaders')
      .send({ driver: 'catbox', values: { userhash: 'h', evil: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown config field/);
  });

  it('refuses drivers a user may not instantiate', async () => {
    for (const driver of ['x0', 'local', 'hoarder', 'nonsense']) {
      const res = await agent.post('/api/uploaders').send({ driver, values: {} });
      expect(res.status).toBe(400);
    }
  });

  it('is blocked by the admin lockdown switch', async () => {
    setAllowUserDefinedUploaders(false);
    try {
      const res = await agent
        .post('/api/uploaders')
        .send({ driver: 'catbox', values: { userhash: 'h' } });
      expect(res.status).toBe(403);
    } finally {
      setAllowUserDefinedUploaders(true);
    }
  });
});

describe('PATCH /api/uploaders/:id', () => {
  it('keeps the stored secret when the field is omitted', async () => {
    const created = await createCatbox('keep-me');

    const res = await agent.patch(`/api/uploaders/${created.id}`).send({ label: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Renamed');
    expect(res.body.secretsSet).toEqual({ userhash: true });

    const { resolvedConfig } = await import('../db/uploaderConfig.js');
    expect(resolvedConfig(getUploaderConfig(created.id)!).userhash).toBe('keep-me');
  });

  it('an empty secret means "keep", not "clear"', async () => {
    const created = await createCatbox('still-here');
    await agent.patch(`/api/uploaders/${created.id}`).send({ values: { userhash: '' } });

    const { resolvedConfig } = await import('../db/uploaderConfig.js');
    expect(resolvedConfig(getUploaderConfig(created.id)!).userhash).toBe('still-here');
  });

  it('replaces the secret when a new one is sent', async () => {
    const created = await createCatbox('old');
    await agent.patch(`/api/uploaders/${created.id}`).send({ values: { userhash: 'new' } });

    const { resolvedConfig } = await import('../db/uploaderConfig.js');
    expect(resolvedConfig(getUploaderConfig(created.id)!).userhash).toBe('new');
  });

  it('someone else’s uploader is a 404, not a 403 (no probing)', async () => {
    const created = await createCatbox();
    const res = await intruderAgent.patch(`/api/uploaders/${created.id}`).send({ label: 'pwned' });
    expect(res.status).toBe(404);
    expect(getUploaderConfig(created.id)!.label).toBe('My catbox');
  });

  it('an instance uploader is not editable here even by its owner-less self', async () => {
    const x0 = listInstanceUploaders().find((r) => r.driver === 'x0')!;
    const res = await agent.patch(`/api/uploaders/${x0.id}`).send({ label: 'mine now' });
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/uploaders/selection', () => {
  it('selects an allowed uploader, and the resolver agrees', async () => {
    const created = await createCatbox();
    const res = await agent.put('/api/uploaders/selection').send({ id: created.id });
    expect(res.status).toBe(200);
    expect(res.body.selectedId).toBe(created.id);

    // The picker and the upload path must never disagree about what's usable.
    expect(resolveUploader({ userId: user.id }).configId).toBe(created.id);
  });

  it('null falls back to the instance default', async () => {
    const res = await agent.put('/api/uploaders/selection').send({ id: null });
    expect(res.status).toBe(200);
    expect(res.body.selectedId).toBeNull();

    const x0 = listInstanceUploaders().find((r) => r.driver === 'x0')!;
    expect(resolveUploader({ userId: user.id }).configId).toBe(x0.id);
  });

  it('refuses an uploader that is not yours', async () => {
    const mine = await createCatbox();
    const res = await intruderAgent.put('/api/uploaders/selection').send({ id: mine.id });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/uploaders/:id', () => {
  it('removes it and clears the selection that pointed at it', async () => {
    const created = await createCatbox();
    await agent.put('/api/uploaders/selection').send({ id: created.id });

    expect((await agent.delete(`/api/uploaders/${created.id}`)).status).toBe(200);
    expect(getUploaderConfig(created.id)).toBeNull();

    // Not left dangling: the pane shows "server default", and the resolver uses it.
    const res = await agent.get('/api/uploaders');
    expect(res.body.selectedId).toBeNull();
  });

  it('someone else cannot delete yours', async () => {
    const created = await createCatbox();
    expect((await intruderAgent.delete(`/api/uploaders/${created.id}`)).status).toBe(404);
    expect(getUploaderConfig(created.id)).not.toBeNull();
  });
});
