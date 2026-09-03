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

// CertFP (#459). The cert deliberately does NOT ride the PATCH allowlist, so
// these routes are the whole write surface — and the private key must never
// leave through any of the read ones.
describe('client certificate', () => {
  async function netWithCert(agent: LurkerTestAgent = aliceAgent) {
    const id = (await makeNet(agent, { name: `cert-${Math.random()}`, nick: 'certnick' })).body
      .network.id;
    const res = await agent.post(`/api/networks/${id}/certificate`).send({ mode: 'generate' });
    expect(res.status).toBe(200);
    return { id, res };
  }

  it('generates a pair and reports its fingerprint', async () => {
    const { res } = await netWithCert();
    expect(res.body.certificate.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.network.client_cert.sha256).toBe(res.body.certificate.sha256);
    // CN borrows the nick so the cert is recognisable in another client's list.
    expect(res.body.certificate.subject).toContain('certnick');
  });

  it('never ships the private key with a network payload', async () => {
    const { id } = await netWithCert();
    const listing = await aliceAgent.get('/api/networks');
    const mine = listing.body.networks.find((n: { id: number }) => n.id === id);
    expect(mine.client_cert.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(mine.client_key).toBeUndefined();
    expect(JSON.stringify(listing.body)).not.toContain('PRIVATE KEY');
  });

  it('imports an existing pair, keeping the fingerprint services already know', async () => {
    const { generateClientCert, describeClientCert } = await import('../utils/clientCert.js');
    const pair = await generateClientCert('elsewhere');
    const id = (await makeNet(aliceAgent, { name: 'import-me' })).body.network.id;
    const res = await aliceAgent
      .post(`/api/networks/${id}/certificate`)
      .send({ mode: 'import', cert: pair.cert, key: pair.key });
    expect(res.status).toBe(200);
    expect(res.body.certificate.sha256).toBe(describeClientCert(pair.cert).sha256);
  });

  it('rejects a mismatched pair with a message, not a stack trace', async () => {
    const { generateClientCert } = await import('../utils/clientCert.js');
    const [mine, theirs] = await Promise.all([generateClientCert('a'), generateClientCert('b')]);
    const id = (await makeNet(aliceAgent, { name: 'bad-import' })).body.network.id;
    const res = await aliceAgent
      .post(`/api/networks/${id}/certificate`)
      .send({ mode: 'import', cert: mine.cert, key: theirs.key });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't match/);
    expect(
      (await aliceAgent.get('/api/networks')).body.networks.find((n: { id: number }) => n.id === id)
        .client_cert,
    ).toBe(null);
  });

  // A certificate is presented during a TLS handshake; a plaintext network has
  // none, so attaching one would hand the user a fingerprint to register that
  // the network is never shown.
  it('refuses to attach a certificate to a plaintext network', async () => {
    const id = (await makeNet(aliceAgent, { name: 'plaintext', tls: false, port: 6667 })).body
      .network.id;
    const res = await aliceAgent.post(`/api/networks/${id}/certificate`).send({ mode: 'generate' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/TLS/);
  });

  // Turning TLS off would strand the network: every dial is then refused
  // because the certificate can't be presented, and PATCH can't clear it.
  it('refuses to turn TLS off while a certificate is attached', async () => {
    const { id } = await netWithCert();
    const res = await aliceAgent.patch(`/api/networks/${id}`).send({ tls: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/remove/i);
    // Still TLS, still connectable.
    const after = (await aliceAgent.get('/api/networks')).body.networks.find(
      (n: { id: number }) => n.id === id,
    );
    expect(after.tls).toBe(true);
    // And the order that does work.
    expect((await aliceAgent.delete(`/api/networks/${id}/certificate`)).status).toBe(200);
    expect((await aliceAgent.patch(`/api/networks/${id}`).send({ tls: false })).status).toBe(200);
  });

  // Archive import writes both columns verbatim, so a stored certificate that
  // doesn't parse is reachable without anyone pasting one. Reading as "no
  // certificate" would leave the user looking at a network that claims to have
  // none and refuses to connect because of one.
  it('says a stored certificate is unusable rather than pretending there is none', async () => {
    const { id } = await netWithCert();
    const db = (await import('../db/index.js')).default;
    db.prepare('UPDATE networks SET client_cert = ? WHERE id = ?').run('not a pem', id);
    const listed = (await aliceAgent.get('/api/networks')).body.networks.find(
      (n: { id: number }) => n.id === id,
    );
    expect(listed.client_cert).toEqual({ unusable: true });
    expect(listed.client_key).toBeUndefined();
  });

  it('rejects an unknown mode rather than silently doing nothing', async () => {
    const id = (await makeNet(aliceAgent, { name: 'bad-mode' })).body.network.id;
    const res = await aliceAgent.post(`/api/networks/${id}/certificate`).send({ mode: 'rotate' });
    expect(res.status).toBe(400);
  });

  it('exports the pair as the single file other clients keep on disk', async () => {
    const { id, res: gen } = await netWithCert();
    const res = await aliceAgent.get(`/api/networks/${id}/certificate/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('.pem');
    expect(res.text).toContain('BEGIN PRIVATE KEY');
    expect(res.text).toContain('BEGIN CERTIFICATE');
    const { describeClientCert } = await import('../utils/clientCert.js');
    const cert = res.text.slice(res.text.indexOf('-----BEGIN CERTIFICATE-----'));
    expect(describeClientCert(cert).sha256).toBe(gen.body.certificate.sha256);
  });

  it('has nothing to export before a cert is attached', async () => {
    const id = (await makeNet(aliceAgent, { name: 'no-cert' })).body.network.id;
    expect((await aliceAgent.get(`/api/networks/${id}/certificate/export`)).status).toBe(404);
  });

  it('clears the pair on delete', async () => {
    const { id } = await netWithCert();
    const res = await aliceAgent.delete(`/api/networks/${id}/certificate`);
    expect(res.status).toBe(200);
    expect(res.body.network.client_cert).toBe(null);
    expect((await aliceAgent.get(`/api/networks/${id}/certificate/export`)).status).toBe(404);
  });

  // Ownership, on every verb: a fingerprint identifies its owner to services,
  // and the key IS the credential.
  it("refuses another user's network on every verb", async () => {
    const { id } = await netWithCert();
    expect(
      (await bobAgent.post(`/api/networks/${id}/certificate`).send({ mode: 'generate' })).status,
    ).toBe(404);
    expect((await bobAgent.get(`/api/networks/${id}/certificate/export`)).status).toBe(404);
    expect((await bobAgent.delete(`/api/networks/${id}/certificate`)).status).toBe(404);
    // ...and alice still has hers.
    expect((await aliceAgent.get(`/api/networks/${id}/certificate/export`)).status).toBe(200);
  });

  it('ignores a cert smuggled through a PATCH body', async () => {
    const id = (await makeNet(aliceAgent, { name: 'patch-smuggle' })).body.network.id;
    const res = await aliceAgent
      .patch(`/api/networks/${id}`)
      .send({ client_cert: 'not a pem', client_key: 'not a key', name: 'renamed' });
    expect(res.status).toBe(200);
    expect(res.body.network.name).toBe('renamed');
    expect(res.body.network.client_cert).toBe(null);
    expect((await aliceAgent.get(`/api/networks/${id}/certificate/export`)).status).toBe(404);
  });
});
