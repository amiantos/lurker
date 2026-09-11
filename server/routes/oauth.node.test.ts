// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// OAuth sign-in (#891) on a cell in node edition, through the app as buildApp wires
// it. The orchestrator in front of the cells keeps the app registry and routes each
// code and token by the cell name it starts with. This file covers the cell's half:
// it takes an app from the orchestrator, approves and exchanges exactly as a
// self-hosted server does, mints codes and tokens the orchestrator can route, and
// revokes every app a member approved when told to, sockets included.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Read when the app is built in beforeAll. vitest gives this file its own process.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NODE_SECRET = 'test-node-secret';
process.env.LURKER_NODE_NAME = 'cell-1';

import crypto from 'crypto';
import http from 'http';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { Express } from 'express';
import { createAuthedAgent, setupTestDb, TEST_SESSION_SECRET } from '../test-utils/testApp.js';
import { WS_CLOSE_SESSION_REVOKED } from '../../shared/wsCloseCodes.js';

const ctx = setupTestDb('routes-oauth-node');

const FLEET = 'Bearer test-node-secret';
const OOB = 'urn:ietf:wg:oauth:2.0:oob';
// The cell's name, a `~`, and the 43-character base64url secret.
const ROUTABLE = /^cell-1~[A-Za-z0-9_-]{43}$/;

let app: Express;
let server: http.Server;
let wsUrl: string;
let createUser: typeof import('../db/users.js').createUser;
let createSession: typeof import('../db/sessions.js').createSession;

beforeAll(async () => {
  ({ createUser } = await import('../db/users.js'));
  ({ createSession } = await import('../db/sessions.js'));
  const { buildApp } = await import('../app.js');
  const wsHub = await import('../services/wsHub.js');
  app = buildApp(TEST_SESSION_SECRET);
  // HTTP and the hub on one server, so the sockets a revoke has to close are the
  // ones this process opened.
  server = http.createServer(app);
  wsHub.attachWsHub(server, TEST_SESSION_SECRET);
  server.listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind synchronously to a TCP port');
  }
  server.unref();
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
});

afterAll(() => {
  server.close();
  ctx.cleanup();
});

// The orchestrator hands the cell an app it registered.
async function handOver(name: string): Promise<string> {
  const clientId = crypto.randomBytes(32).toString('base64url');
  const res = await request(server)
    .put(`/api/node/oauth/apps/${clientId}`)
    .set('Authorization', FLEET)
    .send({ client_name: name, redirect_uris: [OOB] });
  expect(res.status).toBe(200);
  return clientId;
}

// The member approves the app in the browser, out-of-band.
async function approve(
  userId: number,
  clientId: string,
): Promise<{ code: string; verifier: string }> {
  const member = await createAuthedAgent(app, userId);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const page = await member.get('/api/oauth/authorize').query({
    client_id: clientId,
    redirect_uri: OOB,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  expect(page.status).toBe(200);
  const approved = await member
    .post('/api/oauth/authorize')
    .send({ ...page.body.request, decision: 'approve' });
  expect(approved.status).toBe(200);
  return { code: approved.body.code, verifier };
}

function exchange(clientId: string, code: string, verifier: string) {
  return request(server).post('/api/oauth/token').type('form').send({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: OOB,
    code_verifier: verifier,
  });
}

async function tokenFor(userId: number, clientId: string): Promise<string> {
  const { code, verifier } = await approve(userId, clientId);
  const res = await exchange(clientId, code, verifier);
  expect(res.status).toBe(200);
  return res.body.access_token;
}

function me(token: string) {
  return request(server).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
}

// Open a socket and resolve once it has received its first frame, so the server
// has definitely registered it before anything tries to close it.
function connect(bearer: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${bearer}` } });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timed out waiting for the first frame'));
    }, 5000);
    ws.once('message', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket was never closed')), 5000);
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('OAuth on a cell', () => {
  it('approves and exchanges an app the orchestrator handed over, minting routable codes and tokens', async () => {
    const user = createUser('node-oauth-flow');
    const clientId = await handOver('Fleet TUI');
    const { code, verifier } = await approve(user.id, clientId);
    expect(code).toMatch(ROUTABLE);

    const res = await exchange(clientId, code, verifier);
    expect(res.status).toBe(200);
    expect(res.body.access_token).toMatch(ROUTABLE);
    expect((await me(res.body.access_token)).status).toBe(200);
  });

  it('takes no registrations and serves no discovery document of its own', async () => {
    const register = await request(server)
      .post('/api/oauth/register')
      .send({ client_name: 'Direct', redirect_uris: [OOB] });
    expect(register.status).toBe(404);
    expect((await request(server).get('/.well-known/oauth-authorization-server')).status).toBe(404);
  });

  it('refuses an app the orchestrator never handed over', async () => {
    const user = createUser('node-oauth-unknown');
    const member = await createAuthedAgent(app, user.id);
    const res = await member.get('/api/oauth/authorize').query({
      client_id: crypto.randomBytes(32).toString('base64url'),
      redirect_uri: OOB,
      response_type: 'code',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
  });

  it('lets the token into /mcp', async () => {
    const user = createUser('node-oauth-mcp');
    const token = await tokenFor(user.id, await handOver('Fleet agent'));
    const res = await request(server)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe('lurker');
  });

  it('lists the app in Settings, and revokes it with RFC 7009', async () => {
    const user = createUser('node-oauth-revoke');
    const clientId = await handOver('Fleet revoked');
    const token = await tokenFor(user.id, clientId);
    const member = await createAuthedAgent(app, user.id);
    const list = await member.get('/api/oauth/apps');
    expect(list.body.apps.map((a: { name: string }) => a.name)).toEqual(['Fleet revoked']);

    const revoked = await request(server)
      .post('/api/oauth/revoke')
      .type('form')
      .send({ client_id: clientId, token });
    expect(revoked.status).toBe(200);
    expect((await me(token)).status).toBe(401);
  });

  it('revokes every app a member approved when the orchestrator says so', async () => {
    const user = createUser('node-oauth-revoke-all');
    const token = await tokenFor(user.id, await handOver('Fleet socket'));
    const pendingClientId = await handOver('Fleet pending');
    const unexchanged = await approve(user.id, pendingClientId);
    const subscribed = await request(server)
      .post('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: 'https://push.example/fleet-app', keys: { p256dh: 'key', auth: 'auth' } });
    expect(subscribed.status).toBe(201);
    const appSocket = await connect(token);
    const sessionSocket = await connect(createSession(user.id).token);
    const evicted = closed(appSocket);

    const res = await request(server)
      .post(`/api/node/users/${user.id}/oauth/revoke`)
      .set('Authorization', FLEET);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(1);

    // The app's socket closes; the member's own session stays connected.
    expect(await evicted).toBe(WS_CLOSE_SESSION_REVOKED);
    expect(sessionSocket.readyState).toBe(WebSocket.OPEN);
    sessionSocket.close();
    expect((await me(token)).status).toBe(401);
    // A code approved but not yet exchanged is gone too.
    const late = await exchange(pendingClientId, unexchanged.code, unexchanged.verifier);
    expect(late.status).toBe(400);
    expect(late.body.error).toBe('invalid_grant');
    const push = await import('../db/pushSubscriptions.js');
    expect(push.listAllForUser(user.id).map((s) => s.endpoint)).not.toContain(
      'https://push.example/fleet-app',
    );
  });
});
