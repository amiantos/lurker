// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-networks');

// Stand-in ircManager so route handlers can call into it without opening real
// IRC sockets. Methods record their calls so individual tests can assert on
// them; joinChannel/partChannel default to "connected" (true) but tests can
// flip them to false to exercise the 409 path.
const fakeManager = {
  calls: Array<unknown[]>(),
  reset() {
    this.calls = [];
  },
  startNetwork(userId: number, networkId: number) {
    this.calls.push(['startNetwork', userId, networkId]);
  },
  stopNetwork(userId: number, networkId: number, reason: string) {
    this.calls.push(['stopNetwork', userId, networkId, reason]);
  },
  restartNetwork(userId: number, networkId: number) {
    this.calls.push(['restartNetwork', userId, networkId]);
  },
  disposeNetwork(userId: number, networkId: number, reason: string) {
    this.calls.push(['disposeNetwork', userId, networkId, reason]);
  },
  // DELETE re-publishes the contact list after the cascade; the route reads it
  // back from here to fan out a fresh contacts-snapshot.
  listContacts(userId: number) {
    this.calls.push(['listContacts', userId]);
    return [];
  },
  joinChannel(userId: number, networkId: number, channel: string, key?: string) {
    this.calls.push(['joinChannel', userId, networkId, channel, key]);
    return this.joinReturn !== undefined ? this.joinReturn : true;
  },
  partChannel(userId: number, networkId: number, channel: string, reason: string) {
    this.calls.push(['partChannel', userId, networkId, channel, reason]);
    return this.partReturn !== undefined ? this.partReturn : true;
  },
  joinReturn: undefined as boolean | undefined,
  partReturn: undefined as boolean | undefined,
};

vi.mock('../services/ircManager.js', () => ({ default: fakeManager }));

let app: Express;
let aliceAgent: LurkerTestAgent;
let bobAgent: LurkerTestAgent;
let alice: User;
let bob: User;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./networks.js')).default;

  alice = createUser('net-alice');
  bob = createUser('net-bob');
  app = createTestApp({ '/api/networks': router });
  aliceAgent = await createAuthedAgent(app, alice.id);
  bobAgent = await createAuthedAgent(app, bob.id);
});

afterAll(() => ctx.cleanup());

beforeEach(() => fakeManager.reset());

function makeNet(agent: LurkerTestAgent, fields: Record<string, unknown> = {}) {
  return agent.post('/api/networks').send({
    name: 'libera',
    host: 'irc.libera.chat',
    port: 6697,
    tls: true,
    nick: 'n',
    autoconnect: false,
    ...fields,
  });
}

describe('GET /api/networks', () => {
  it('requires auth', async () => {
    const res = await createAnonAgent(app).get('/api/networks');
    expect(res.status).toBe(401);
  });

  it("returns only the caller's networks, with secrets redacted", async () => {
    await makeNet(aliceAgent, { name: 'alice-net', server_password: 'shh' });
    await makeNet(bobAgent, { name: 'bob-net' });

    const res = await aliceAgent.get('/api/networks');
    expect(res.status).toBe(200);
    const names = res.body.networks.map((n: { name: string }) => n.name);
    expect(names).toContain('alice-net');
    expect(names).not.toContain('bob-net');
    const aliceNet = res.body.networks.find((n: { name: string }) => n.name === 'alice-net');
    expect(aliceNet.server_password).toBeUndefined();
    expect(aliceNet.has_password).toBe(true);
  });
});

describe('POST /api/networks', () => {
  it('rejects missing required fields', async () => {
    const res = await aliceAgent.post('/api/networks').send({ name: 'incomplete' });
    expect(res.status).toBe(400);
  });

  // Creating a network is the explicit "Save & connect" action, so it connects
  // now whether or not autoconnect is set. autoconnect only governs automatic
  // connection at cold-start / un-pause resume, not this initial setup.
  it('starts the connection on create when autoconnect is true', async () => {
    const res = await makeNet(aliceAgent, { autoconnect: true, name: 'autoconn' });
    expect(res.status).toBe(201);
    expect(fakeManager.calls.some(([m]) => m === 'startNetwork')).toBe(true);
  });

  it('still starts the connection on create when autoconnect is false (#186)', async () => {
    fakeManager.reset();
    const res = await makeNet(aliceAgent, { autoconnect: false, name: 'no-autoconn' });
    expect(res.status).toBe(201);
    expect(fakeManager.calls.some(([m]) => m === 'startNetwork')).toBe(true);
  });

  it('500s and does not connect if createNetwork returns undefined', async () => {
    const networksDb = await import('../db/networks.js');
    const spy = vi.spyOn(networksDb, 'createNetwork').mockReturnValueOnce(undefined);
    fakeManager.reset();
    try {
      const res = await makeNet(aliceAgent, { name: 'doomed-create' });
      expect(res.status).toBe(500);
      // A failed creation must not leave a dangling connection attempt behind.
      expect(fakeManager.calls.some(([m]) => m === 'startNetwork')).toBe(false);
    } finally {
      // Restore in finally so a thrown assertion can't leak the spy into later tests.
      spy.mockRestore();
    }
  });

  it('upserts default_channel into the channels list', async () => {
    const created = await makeNet(aliceAgent, { name: 'with-default', default_channel: '#dev' });
    expect(
      created.body.network.channels.find((c: { name: string }) => c.name === '#dev'),
    ).toBeTruthy();
  });

  it('allows disabling trusted-cert verification on create', async () => {
    const res = await makeNet(aliceAgent, { name: 'self-signed-ok', trusted_certificates: false });
    expect(res.status).toBe(201);
    expect(res.body.network.trusted_certificates).toBe(false);
  });
});

describe('paused accounts are read-only', () => {
  it('blocks every write with 403 but still serves reads', async () => {
    const { createUser, setUserPaused } = await import('../db/users.js');
    const paula = createUser('net-paula');
    const paulaAgent = await createAuthedAgent(app, paula.id);

    // Create a network while still active, capture its id, then pause.
    const net = await makeNet(paulaAgent, { name: 'paula-net' });
    expect(net.status).toBe(201);
    const netId = net.body.network.id;
    setUserPaused(paula.id, true);
    fakeManager.reset();

    // Reads still work — the sidebar must render for read-only browsing.
    const list = await paulaAgent.get('/api/networks');
    expect(list.status).toBe(200);

    // Every mutation is blocked with a clean 403, and no IRC call leaks through.
    expect((await paulaAgent.post(`/api/networks/${netId}/connect`)).status).toBe(403);
    expect((await paulaAgent.post(`/api/networks/${netId}/reconnect`)).status).toBe(403);
    expect(
      (await paulaAgent.post(`/api/networks/${netId}/join`).send({ channel: '#x' })).status,
    ).toBe(403);
    expect((await makeNet(paulaAgent, { name: 'should-fail' })).status).toBe(403);
    expect(fakeManager.calls.length).toBe(0);

    // Un-pausing restores write access.
    setUserPaused(paula.id, false);
    expect((await paulaAgent.post(`/api/networks/${netId}/connect`)).status).toBe(200);
    expect(fakeManager.calls.some(([m]) => m === 'startNetwork')).toBe(true);
  });
});

describe('PATCH /api/networks/:id', () => {
  it("404s on someone else's network", async () => {
    const bobNet = await makeNet(bobAgent, { name: 'bobs' });
    const res = await aliceAgent
      .patch(`/api/networks/${bobNet.body.network.id}`)
      .send({ nick: 'hacked' });
    expect(res.status).toBe(404);
  });

  it('updates allowed fields', async () => {
    const net = await makeNet(aliceAgent, { name: 'patchable' });
    const res = await aliceAgent
      .patch(`/api/networks/${net.body.network.id}`)
      .send({ nick: 'newnick', trusted_certificates: false });
    expect(res.status).toBe(200);
    expect(res.body.network.nick).toBe('newnick');
    expect(res.body.network.trusted_certificates).toBe(false);
  });
});

describe('DELETE /api/networks/:id', () => {
  it('disposes the connection and deletes the row', async () => {
    const net = await makeNet(aliceAgent, { name: 'doomed' });
    const res = await aliceAgent.delete(`/api/networks/${net.body.network.id}`);
    expect(res.status).toBe(200);
    expect(fakeManager.calls.some(([m]) => m === 'disposeNetwork')).toBe(true);
    // Cascaded contact_targets are re-published so the Friends UI doesn't keep
    // stale targets pointing at the deleted network.
    expect(fakeManager.calls.some(([m]) => m === 'listContacts')).toBe(true);
    const list = await aliceAgent.get('/api/networks');
    expect(
      list.body.networks.find((n: { id: number }) => n.id === net.body.network.id),
    ).toBeUndefined();
  });

  it("404s on a network you don't own", async () => {
    const bobNet = await makeNet(bobAgent, { name: 'mine' });
    const res = await aliceAgent.delete(`/api/networks/${bobNet.body.network.id}`);
    expect(res.status).toBe(404);
  });
});

describe('connect / disconnect / reconnect', () => {
  it('start, stop, restart all 404 for foreign networks', async () => {
    const bobNet = await makeNet(bobAgent, { name: 'bobs-conn' });
    expect((await aliceAgent.post(`/api/networks/${bobNet.body.network.id}/connect`)).status).toBe(
      404,
    );
    expect(
      (await aliceAgent.post(`/api/networks/${bobNet.body.network.id}/disconnect`)).status,
    ).toBe(404);
    expect(
      (await aliceAgent.post(`/api/networks/${bobNet.body.network.id}/reconnect`)).status,
    ).toBe(404);
  });

  it('start / stop / restart route into ircManager for an owned network', async () => {
    const net = await makeNet(aliceAgent, { name: 'flap' });
    const id = net.body.network.id;
    fakeManager.reset();
    await aliceAgent.post(`/api/networks/${id}/connect`);
    await aliceAgent.post(`/api/networks/${id}/disconnect`).send({ reason: 'bye' });
    await aliceAgent.post(`/api/networks/${id}/reconnect`);
    const methods = fakeManager.calls.map(([m]) => m);
    expect(methods).toEqual(['startNetwork', 'stopNetwork', 'restartNetwork']);
  });
});

describe('join / part', () => {
  it('requires a channel name', async () => {
    const net = await makeNet(aliceAgent, { name: 'jp' });
    const id = net.body.network.id;
    expect((await aliceAgent.post(`/api/networks/${id}/join`).send({})).status).toBe(400);
    expect((await aliceAgent.post(`/api/networks/${id}/part`).send({})).status).toBe(400);
  });

  it('forwards an optional channel key to ircManager', async () => {
    const net = await makeNet(aliceAgent, { name: 'keyed' });
    const id = net.body.network.id;
    fakeManager.calls = [];
    expect(
      (await aliceAgent.post(`/api/networks/${id}/join`).send({ channel: '#x', key: 'sekret' }))
        .status,
    ).toBe(200);
    const call = fakeManager.calls.find(([m]) => m === 'joinChannel');
    expect(call).toEqual(['joinChannel', expect.any(Number), id, '#x', 'sekret']);
  });

  it('returns 409 when ircManager reports not-connected', async () => {
    const net = await makeNet(aliceAgent, { name: 'offline' });
    const id = net.body.network.id;
    fakeManager.joinReturn = false;
    fakeManager.partReturn = false;
    expect((await aliceAgent.post(`/api/networks/${id}/join`).send({ channel: '#x' })).status).toBe(
      409,
    );
    expect((await aliceAgent.post(`/api/networks/${id}/part`).send({ channel: '#x' })).status).toBe(
      409,
    );
    fakeManager.joinReturn = undefined;
    fakeManager.partReturn = undefined;
  });
});

describe('POST /api/networks/reorder', () => {
  it('rejects when ids is not an array', async () => {
    const res = await aliceAgent.post('/api/networks/reorder').send({ ids: 'oops' });
    expect(res.status).toBe(400);
  });

  it('returns 409 + current state on mismatched ids', async () => {
    const n1 = await makeNet(aliceAgent, { name: 'r1' });
    const res = await aliceAgent
      .post('/api/networks/reorder')
      .send({ ids: [n1.body.network.id, 999999] });
    expect(res.status).toBe(409);
    expect(Array.isArray(res.body.networks)).toBe(true);
  });

  it('rewrites order on a valid set', async () => {
    const reorderAgent = await createAuthedAgent(
      app,
      (await import('../db/users.js')).createUser('reorder-only').id,
    );
    const a = await makeNet(reorderAgent, { name: 'a' });
    const b = await makeNet(reorderAgent, { name: 'b' });
    const c = await makeNet(reorderAgent, { name: 'c' });
    const res = await reorderAgent.post('/api/networks/reorder').send({
      ids: [c.body.network.id, a.body.network.id, b.body.network.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.networks.map((n: { name: string }) => n.name)).toEqual(['c', 'a', 'b']);
  });
});
