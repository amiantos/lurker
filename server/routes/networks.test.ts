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

  // default_channel is a channel *list* (IRC's own "JOIN #a,#b" syntax), which is
  // how the first-run flow (#300) joins several at once. Before this, a
  // comma-separated value produced a single channel literally named "#a,#b".
  it('splits a comma-separated default_channel into one channel each', async () => {
    const created = await makeNet(aliceAgent, {
      name: 'multi-default',
      default_channel: '#lurker,#libera',
    });
    const names = created.body.network.channels.map((c: { name: string }) => c.name);
    expect(names).toContain('#lurker');
    expect(names).toContain('#libera');
    expect(names).not.toContain('#lurker,#libera');
  });

  it('tolerates whitespace, blanks, and case-insensitive repeats in default_channel', async () => {
    const created = await makeNet(aliceAgent, {
      name: 'messy-default',
      default_channel: ' #lurker ,, #Dev  #lurker,#LURKER ',
    });
    const names = created.body.network.channels.map((c: { name: string }) => c.name).toSorted();
    // Whitespace separates too (it's what people type), empties are dropped, and
    // a channel repeated in another casing is the same channel — the first
    // spelling seen is the one stored. Sorted because listChannels() picks the
    // row order, which isn't what this test is about.
    expect(names).toStrictEqual(['#Dev', '#lurker']);
  });

  it('creates no channels when default_channel is absent or blank', async () => {
    const blank = await makeNet(aliceAgent, { name: 'blank-default', default_channel: '   ' });
    expect(blank.body.network.channels).toStrictEqual([]);
    const absent = await makeNet(aliceAgent, { name: 'absent-default' });
    expect(absent.body.network.channels).toStrictEqual([]);
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

// The instance network lockdown (#298). The predicate itself is covered in
// services/networkPolicy.test.ts; what's tested here is that every route which
// could get a user onto an off-list host actually consults it. Each of these was
// a bypass before it was closed.
describe('instance network lockdown', () => {
  let lockdownAgent: LurkerTestAgent;
  let carol: User;

  beforeAll(async () => {
    const { createUser } = await import('../db/users.js');
    carol = createUser('net-carol');
    lockdownAgent = await createAuthedAgent(app, carol.id);
  });

  beforeEach(async () => {
    const dbMod = (await import('../db/index.js')).default;
    dbMod.prepare('DELETE FROM instance_network').run();
    const { setAllowUserDefinedNetworks } = await import('../db/instanceSettings.js');
    const { createInstanceNetwork } = await import('../db/instanceNetworks.js');
    createInstanceNetwork({ name: 'Corp', host: 'irc.corp.example' });
    setAllowUserDefinedNetworks(false);
  });

  afterAll(async () => {
    const dbMod = (await import('../db/index.js')).default;
    dbMod.prepare('DELETE FROM instance_network').run();
    const { setAllowUserDefinedNetworks } = await import('../db/instanceSettings.js');
    setAllowUserDefinedNetworks(true);
  });

  it('refuses to create a network on an unlisted host', async () => {
    const res = await makeNet(lockdownAgent, { name: 'libera', host: 'irc.libera.chat' });
    expect(res.status).toBe(403);
    expect(fakeManager.calls.some(([m]) => m === 'startNetwork')).toBe(false);
  });

  it('still allows creating a network on a listed host', async () => {
    const res = await makeNet(lockdownAgent, { name: 'corp', host: 'irc.corp.example' });
    expect(res.status).toBe(201);
    expect(res.body.network.blocked).toBe(false);
  });

  // The bypass that makes the whole thing a formality if it's missed: create an
  // approved network, then simply edit its host to wherever you actually wanted.
  it('refuses to repoint an approved network at an unlisted host', async () => {
    const created = await makeNet(lockdownAgent, { name: 'corp', host: 'irc.corp.example' });
    const res = await lockdownAgent
      .patch(`/api/networks/${created.body.network.id}`)
      .send({ host: 'irc.libera.chat' });
    expect(res.status).toBe(403);
  });

  it('still allows editing everything else on an approved network', async () => {
    const created = await makeNet(lockdownAgent, { name: 'corp', host: 'irc.corp.example' });
    const res = await lockdownAgent
      .patch(`/api/networks/${created.body.network.id}`)
      .send({ nick: 'newnick' });
    expect(res.status).toBe(200);
    expect(res.body.network.nick).toBe('newnick');
  });

  describe('a network that predates the lockdown', () => {
    // Created while the instance was still open, then locked down underneath it.
    // The row survives — the policy blocks connections, it doesn't confiscate
    // networks or (via ON DELETE CASCADE) destroy their history.
    async function makeStranded() {
      const { setAllowUserDefinedNetworks } = await import('../db/instanceSettings.js');
      setAllowUserDefinedNetworks(true);
      const created = await makeNet(lockdownAgent, { name: 'old', host: 'irc.libera.chat' });
      setAllowUserDefinedNetworks(false);
      fakeManager.reset();
      return created.body.network.id as number;
    }

    it('is reported as blocked, and survives', async () => {
      const id = await makeStranded();
      const res = await lockdownAgent.get('/api/networks');
      const row = res.body.networks.find((n: { id: number }) => n.id === id);
      expect(row).toBeTruthy();
      expect(row.blocked).toBe(true);
    });

    it('cannot be connected', async () => {
      const id = await makeStranded();
      const res = await lockdownAgent.post(`/api/networks/${id}/connect`);
      expect(res.status).toBe(403);
      expect(fakeManager.calls.some(([m]) => m === 'startNetwork')).toBe(false);
    });

    it('cannot be reconnected', async () => {
      const id = await makeStranded();
      const res = await lockdownAgent.post(`/api/networks/${id}/reconnect`);
      expect(res.status).toBe(403);
      expect(fakeManager.calls.some(([m]) => m === 'restartNetwork')).toBe(false);
    });

    // Blocked is not the same as owned-by-the-admin: the user can still get rid
    // of it, which is their only way out if they don't want it sitting there.
    it('can still be deleted by its owner', async () => {
      const id = await makeStranded();
      const res = await lockdownAgent.delete(`/api/networks/${id}`);
      expect(res.status).toBe(200);
    });
  });
});
