// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Edition + node secret are read at request time; set them before importing the
// router. vitest runs each test file in its own process, so this is scoped here.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NODE_SECRET = 'test-node-secret';

import type { Express } from 'express';
import { unsign } from 'cookie-signature';
import {
  setupTestDb,
  createTestApp,
  createAnonAgent,
  TEST_SESSION_SECRET,
} from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-node');
const AUTH = 'Bearer test-node-secret';

let app: Express;
let findUserById: typeof import('../db/users.js').findUserById;
let createUser: typeof import('../db/users.js').createUser;

beforeAll(async () => {
  const users = await import('../db/users.js');
  findUserById = users.findUserById;
  createUser = users.createUser;
  const router = (await import('./node.js')).default;
  app = createTestApp({ '/api/node': router });
});

afterAll(() => ctx.cleanup());

describe('node control API — auth', () => {
  it('rejects requests with no bearer (401)', async () => {
    expect((await createAnonAgent(app).get('/api/node/status')).status).toBe(401);
  });

  it('rejects a wrong secret (401)', async () => {
    const res = await createAnonAgent(app)
      .get('/api/node/status')
      .set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });

  it('503s when no node secret is configured', async () => {
    const saved = process.env.LURKER_NODE_SECRET;
    delete process.env.LURKER_NODE_SECRET;
    try {
      const res = await createAnonAgent(app).get('/api/node/status').set('Authorization', AUTH);
      expect(res.status).toBe(503);
    } finally {
      process.env.LURKER_NODE_SECRET = saved;
    }
  });
});

describe('node control API — status', () => {
  it('reports edition + user count with a valid secret', async () => {
    const res = await createAnonAgent(app).get('/api/node/status').set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.edition).toBe('node');
    expect(typeof res.body.users.count).toBe('number');
    expect(typeof res.body.version).toBe('string');
  });
});

describe('node control API — provision', () => {
  it('creates a tenant account as role=user and returns its id', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'tenant-alice' });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('tenant-alice');
    expect(typeof res.body.id).toBe('number');
    expect(findUserById(res.body.id)?.role).toBe('user');
  });

  it('never mints an admin, even if the body asks for one', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'tenant-mallory', role: 'admin' });
    expect(res.status).toBe(201);
    expect(findUserById(res.body.id)?.role).toBe('user');
  });

  it('rejects a missing username (400)', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects a username with disallowed characters (400)', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'no/slashes' });
    expect(res.status).toBe(400);
  });

  it('409s on a duplicate username and surfaces the existing id', async () => {
    const first = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'tenant-dupe' });
    expect(first.status).toBe(201);
    const second = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'tenant-dupe' });
    expect(second.status).toBe(409);
    expect(second.body.id).toBe(first.body.id);
  });

  it('reconciles a retry that differs only by case, rather than creating a second row', async () => {
    const first = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'acct-4242' });
    expect(first.status).toBe(201);
    const retry = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'ACCT-4242' });
    // 409 WITH the existing id is what the control plane recovers from
    // (cellClient.provisionUserOnCell treats it as success) — an id-less 409
    // would surface as provision_failed for what is really the same tenant.
    expect(retry.status).toBe(409);
    expect(retry.body.id).toBe(first.body.id);
  });

  it('refuses WITHOUT an id when the name folds to two grandfathered rows', async () => {
    // Only reachable on a cell carrying case-twins, which hosted provisioning
    // never creates. The cell can't say which account is meant, and guessing
    // would bind a customer to the wrong row — so `id` is omitted, which the
    // control plane treats as a failure needing a human rather than recovering.
    const db = (await import('../db/index.js')).default;
    // The twins can only be inserted with the NOCASE index absent — which is
    // precisely the state this branch exists for: the index is skipped at boot
    // exactly when such a pair already exists (db/index.ts). Dropping it here
    // reproduces that DB rather than a state production could never reach.
    db.exec('DROP INDEX IF EXISTS idx_users_username_nocase');
    const insert = db.prepare('INSERT INTO users (username, role) VALUES (?, ?)');
    insert.run('Twinned', 'user');
    insert.run('twinned', 'user');
    const res = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'TWINNED' });
    expect(res.status).toBe(409);
    expect(res.body.id).toBeUndefined();
    expect(res.body.error).toMatch(/more than one/);

    // Put the schema back so no later test silently runs without the backstop.
    db.prepare('DELETE FROM users WHERE username IN (?, ?)').run('Twinned', 'twinned');
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase
         ON users(username COLLATE NOCASE)`,
    );
  });
});

describe('node control API — deprovision', () => {
  it('deletes a tenant account', async () => {
    const created = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'tenant-bob' });
    const id = created.body.id;
    const del = await createAnonAgent(app)
      .delete(`/api/node/users/${id}`)
      .set('Authorization', AUTH);
    expect(del.status).toBe(200);
    expect(findUserById(id)).toBeUndefined();
  });

  it('404s on an unknown user', async () => {
    const res = await createAnonAgent(app)
      .delete('/api/node/users/999999')
      .set('Authorization', AUTH);
    expect(res.status).toBe(404);
  });

  it('refuses to delete an admin (the operator) via the node API', async () => {
    const admin = createUser('operator', { role: 'admin' });
    const res = await createAnonAgent(app)
      .delete(`/api/node/users/${admin.id}`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(409);
    expect(findUserById(admin.id)).toBeDefined();
  });
});

describe('node control API — mint session', () => {
  it('mints a signed lurker_session cookie that maps to a real session for the user', async () => {
    const created = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'mint-me' });
    const id = created.body.id;

    const res = await createAnonAgent(app)
      .post(`/api/node/users/${id}/session`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.cookieName).toBe('lurker_session');
    expect(typeof res.body.value).toBe('string');
    expect(res.body.value.startsWith('s:')).toBe(true);

    // The signed value must unsign with the cell's secret and resolve to a real
    // session row owned by this user — i.e. the cell's own auth will accept it.
    const token = unsign(res.body.value.slice(2), TEST_SESSION_SECRET);
    expect(token).not.toBe(false);
    const { findSession } = await import('../db/sessions.js');
    expect(findSession(token as string)?.user_id).toBe(id);
  });

  it('404s minting for an unknown user', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users/999999/session')
      .set('Authorization', AUTH);
    expect(res.status).toBe(404);
  });

  it('refuses to mint a session for an admin', async () => {
    const admin = createUser('mint-admin', { role: 'admin' });
    const res = await createAnonAgent(app)
      .post(`/api/node/users/${admin.id}/session`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(409);
  });

  it('requires the node secret', async () => {
    const created = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username: 'mint-noauth' });
    const res = await createAnonAgent(app).post(`/api/node/users/${created.body.id}/session`);
    expect(res.status).toBe(401);
  });
});

describe('node control API — pause/resume', () => {
  async function provision(username: string): Promise<number> {
    const res = await createAnonAgent(app)
      .post('/api/node/users')
      .set('Authorization', AUTH)
      .send({ username });
    return res.body.id;
  }

  it('pauses a tenant and flips is_paused', async () => {
    const id = await provision('pause-me');
    expect(findUserById(id)?.is_paused).toBe(0);
    const res = await createAnonAgent(app)
      .post(`/api/node/users/${id}/pause`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(findUserById(id)?.is_paused).toBe(1);
  });

  it('is idempotent — re-pausing stays paused and still 200s', async () => {
    const id = await provision('pause-twice');
    await createAnonAgent(app).post(`/api/node/users/${id}/pause`).set('Authorization', AUTH);
    const again = await createAnonAgent(app)
      .post(`/api/node/users/${id}/pause`)
      .set('Authorization', AUTH);
    expect(again.status).toBe(200);
    expect(findUserById(id)?.is_paused).toBe(1);
  });

  it('resumes a paused tenant and clears is_paused', async () => {
    const id = await provision('resume-me');
    await createAnonAgent(app).post(`/api/node/users/${id}/pause`).set('Authorization', AUTH);
    expect(findUserById(id)?.is_paused).toBe(1);
    const res = await createAnonAgent(app)
      .post(`/api/node/users/${id}/resume`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(findUserById(id)?.is_paused).toBe(0);
  });

  it('404s pausing an unknown user', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users/999999/pause')
      .set('Authorization', AUTH);
    expect(res.status).toBe(404);
  });

  it('refuses to pause an admin (the operator)', async () => {
    const admin = createUser('pause-admin', { role: 'admin' });
    const res = await createAnonAgent(app)
      .post(`/api/node/users/${admin.id}/pause`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(409);
    expect(findUserById(admin.id)?.is_paused).toBe(0);
  });

  it('requires the node secret', async () => {
    const id = await provision('pause-noauth');
    const res = await createAnonAgent(app).post(`/api/node/users/${id}/pause`);
    expect(res.status).toBe(401);
  });
});

describe('node control API — upload takedown', () => {
  it('flips an upload to removed and drops its inline thumbnail', async () => {
    const { insertUpload, listUploads, getThumbnail } = await import('../db/uploadHistory.js');
    const user = createUser('takedown-owner');
    const uploadId = insertUpload(user.id, {
      provider: 'hoarder',
      url: 'https://cdn.test/x.jpg',
      filename: 'x.png',
      mime: 'image/jpeg',
      byte_size: 100,
      width: 10,
      height: 10,
      thumbnail: Buffer.from([1, 2, 3]),
    });

    const res = await createAnonAgent(app)
      .post(`/api/node/uploads/${uploadId}/takedown`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(200);

    const row = listUploads(user.id).find((r) => r.id === uploadId)!;
    expect(row.removed).toBe(1);
    // Bytes gone: the inline thumbnail BLOB was cleared.
    expect(getThumbnail(user.id, uploadId)?.thumbnail).toBeNull();
  });

  it('is idempotent — re-takedown still 200', async () => {
    const { insertUpload } = await import('../db/uploadHistory.js');
    const user = createUser('takedown-twice');
    const uploadId = insertUpload(user.id, {
      provider: 'hoarder',
      url: 'https://cdn.test/y.jpg',
      mime: 'image/jpeg',
      byte_size: 1,
      thumbnail: null,
    });
    const first = await createAnonAgent(app)
      .post(`/api/node/uploads/${uploadId}/takedown`)
      .set('Authorization', AUTH);
    const second = await createAnonAgent(app)
      .post(`/api/node/uploads/${uploadId}/takedown`)
      .set('Authorization', AUTH);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('404 for an unknown upload id', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/uploads/999999/takedown')
      .set('Authorization', AUTH);
    expect(res.status).toBe(404);
  });

  it('requires the node secret', async () => {
    const res = await createAnonAgent(app).post('/api/node/uploads/1/takedown');
    expect(res.status).toBe(401);
  });
});

describe('node control API — OAuth apps', () => {
  const OOB = 'urn:ietf:wg:oauth:2.0:oob';
  // The orchestrator mints client ids; any base64url string stands in for one here.
  const clientId = (label: string) => `client_${label}_0123456789abcdef`;
  const metadata = {
    client_name: '  Fleet App  ',
    client_uri: 'https://fleet.example',
    redirect_uris: [OOB, OOB],
  };

  it('stores an app the self-hosted registration rules accept, as those rules read it', async () => {
    const oauth = await import('../db/oauth.js');
    const id = clientId('stored');
    const res = await createAnonAgent(app)
      .put(`/api/node/oauth/apps/${id}`)
      .set('Authorization', AUTH)
      .send(metadata);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      client_id: id,
      client_name: 'Fleet App',
      client_uri: 'https://fleet.example',
      redirect_uris: [OOB],
    });
    expect(oauth.findAppByClientId(id)).toMatchObject({
      clientName: 'Fleet App',
      redirectUris: [OOB],
      firstAuthorizedAt: null,
    });
  });

  it('refuses what a self-hosted server would refuse, and stores nothing', async () => {
    const oauth = await import('../db/oauth.js');
    const id = clientId('refused');
    const res = await createAnonAgent(app)
      .put(`/api/node/oauth/apps/${id}`)
      .set('Authorization', AUTH)
      .send({ client_name: 'Phish', redirect_uris: ['javascript:alert(1)'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
    expect(oauth.findAppByClientId(id)).toBeNull();
  });

  it('refuses a client_id that is not base64url', async () => {
    const res = await createAnonAgent(app)
      .put('/api/node/oauth/apps/bad%20id')
      .set('Authorization', AUTH)
      .send(metadata);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid client_id');
  });

  it('keeps the row and metadata it has, and restarts a pending copy’s clock', async () => {
    const oauth = await import('../db/oauth.js');
    const id = clientId('pending');
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const stored = oauth.upsertAppFromFleet(
      id,
      { clientName: 'Original', clientUri: null, redirectUris: [OOB] },
      twoHoursAgo,
    );
    const res = await createAnonAgent(app)
      .put(`/api/node/oauth/apps/${id}`)
      .set('Authorization', AUTH)
      .send(metadata);
    expect(res.status).toBe(200);
    expect(res.body.client_name).toBe('Original');
    expect(oauth.findAppByClientId(id)?.id).toBe(stored.id);
    // Two hours old, the copy was due for the purge. Arriving again keeps it for
    // the member now on the approval page.
    oauth.purgeOAuth();
    expect(oauth.findAppByClientId(id)).not.toBeNull();
  });

  it('leaves an approved app exactly as it is', async () => {
    const oauth = await import('../db/oauth.js');
    const id = clientId('approved');
    const member = createUser('oauth-fleet-approver');
    const longAgo = Date.now() - 2 * 60 * 60 * 1000;
    const stored = oauth.upsertAppFromFleet(
      id,
      { clientName: 'Approved', clientUri: null, redirectUris: [OOB] },
      longAgo,
    );
    oauth.createCode(
      { appId: stored.id, userId: member.id, redirectUri: OOB, codeChallenge: 'c'.repeat(43) },
      longAgo,
    );
    const before = oauth.findAppByClientId(id);
    const res = await createAnonAgent(app)
      .put(`/api/node/oauth/apps/${id}`)
      .set('Authorization', AUTH)
      .send(metadata);
    expect(res.status).toBe(200);
    expect(oauth.findAppByClientId(id)).toEqual(before);
  });

  it('requires the node secret', async () => {
    const res = await createAnonAgent(app)
      .put(`/api/node/oauth/apps/${clientId('noauth')}`)
      .send(metadata);
    expect(res.status).toBe(401);
  });
});

describe('node control API — revoke a tenant’s OAuth apps', () => {
  const OOB = 'urn:ietf:wg:oauth:2.0:oob';

  it('deletes the tenant’s tokens and unexchanged codes, and nobody else’s', async () => {
    const oauth = await import('../db/oauth.js');
    const owner = createUser('oauth-revoke-owner');
    const other = createUser('oauth-revoke-other');
    const stored = oauth.upsertAppFromFleet('client_revoke_0123456789abcdef', {
      clientName: 'Revoked',
      clientUri: null,
      redirectUris: [OOB],
    });
    const ownerToken = oauth.createToken(stored.id, owner.id);
    const ownerCode = oauth.createCode({
      appId: stored.id,
      userId: owner.id,
      redirectUri: OOB,
      codeChallenge: 'c'.repeat(43),
    });
    const otherToken = oauth.createToken(stored.id, other.id);

    const res = await createAnonAgent(app)
      .post(`/api/node/users/${owner.id}/oauth/revoke`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, revoked: 1 });
    expect(oauth.findTokenByRaw(ownerToken)).toBeNull();
    expect(oauth.consumeCode(ownerCode)).toBeNull();
    expect(oauth.findTokenByRaw(otherToken)).not.toBeNull();
  });

  it('404s an unknown user', async () => {
    const res = await createAnonAgent(app)
      .post('/api/node/users/999999/oauth/revoke')
      .set('Authorization', AUTH);
    expect(res.status).toBe(404);
  });

  it('refuses an admin (the operator)', async () => {
    const admin = createUser('oauth-revoke-admin', { role: 'admin' });
    const res = await createAnonAgent(app)
      .post(`/api/node/users/${admin.id}/oauth/revoke`)
      .set('Authorization', AUTH);
    expect(res.status).toBe(409);
  });

  it('requires the node secret', async () => {
    const owner = createUser('oauth-revoke-noauth');
    const res = await createAnonAgent(app).post(`/api/node/users/${owner.id}/oauth/revoke`);
    expect(res.status).toBe(401);
  });
});
