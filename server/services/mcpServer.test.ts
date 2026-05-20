// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { setupTestDb } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { Network } from '../db/networks.js';
import type { CreateTokenResult } from '../db/apiTokens.js';

const ctx = setupTestDb('mcp-server');

let app: Express;
let owner: User;
let net: Network;
let readToken: CreateTokenResult;
let rwToken: CreateTokenResult;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  const { insertMessage } = await import('../db/messages.js');
  const { createToken } = await import('../db/apiTokens.js');
  // Register verbs as a side effect.
  await import('./verbs/index.js');
  const { default: mcpRouter } = await import('./mcpServer.js');
  const { requireApiAuth } = await import('../middleware/apiAuth.js');

  app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/mcp', requireApiAuth, mcpRouter);

  owner = createUser('mcp-owner');
  net = createNetwork(owner.id, {
    name: 'libera', host: 'h', port: 6697, tls: true, nick: 'owner',
  }) as Network;
  insertMessage({
    networkId: net.id, target: '#chan', time: new Date().toISOString(),
    type: 'message', nick: 'alice', text: 'hello', self: false,
  });
  readToken = createToken({ userId: owner.id, name: 'r', scope: 'read' });
  rwToken = createToken({ userId: owner.id, name: 'rw', scope: 'read-write' });
});

afterAll(() => ctx.cleanup());

function rpc(token: string, body: object) {
  return request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('MCP server', () => {
  it('401 without a bearer token', async () => {
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.status).toBe(401);
  });

  it('initialize returns protocolVersion + serverInfo + tools capability', async () => {
    const res = await rpc(readToken.token, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capabilities: { tools: {} },
        serverInfo: { name: 'lurker' },
      },
    });
    expect(typeof res.body.result.protocolVersion).toBe('string');
  });

  it('tools/list with a read token only advertises read verbs', async () => {
    const res = await rpc(readToken.token, {
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    });
    const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('list_networks');
    expect(names).toContain('recent_messages');
    expect(names).not.toContain('send_message');
    expect(names).not.toContain('set_nick_note');
  });

  it('tools/list with a read-write token advertises the full surface', async () => {
    const res = await rpc(rwToken.token, {
      jsonrpc: '2.0', id: 3, method: 'tools/list',
    });
    const names = (res.body.result.tools as Array<{ name: string; inputSchema: { type: string } }>).map((t) => t.name).sort();
    expect(names).toEqual([
      'get_nick_note',
      'list_buffers',
      'list_networks',
      'recent_messages',
      'search_messages',
      'send_action',
      'send_message',
      'set_nick_note',
    ]);
    // Each entry carries an inputSchema usable by an MCP client.
    for (const tool of res.body.result.tools as Array<{ inputSchema: { type: string } }>) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('tools/call list_networks returns the user\'s networks as a JSON text block', async () => {
    const res = await rpc(readToken.token, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'list_networks', arguments: {} },
    });
    expect(res.body.result.isError).toBe(false);
    const payload = JSON.parse(res.body.result.content[0].text) as Array<{ id: number; name: string }>;
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ id: net.id, name: 'libera' });
  });

  it('tools/call set_nick_note writes and round-trips through get_nick_note', async () => {
    const setRes = await rpc(rwToken.token, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: {
        name: 'set_nick_note',
        arguments: { networkId: net.id, nick: 'alice', note: 'works at Acme' },
      },
    });
    expect(setRes.body.result.isError).toBe(false);
    const setPayload = JSON.parse(setRes.body.result.content[0].text) as { networkId: number; nick: string; note: string };
    expect(setPayload).toMatchObject({ networkId: net.id, nick: 'alice', note: 'works at Acme' });

    const getRes = await rpc(readToken.token, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'get_nick_note', arguments: { networkId: net.id, nick: 'alice' } },
    });
    const getPayload = JSON.parse(getRes.body.result.content[0].text) as { note: string };
    expect(getPayload.note).toBe('works at Acme');
  });

  it('tools/call set_nick_note rejected with a read token, surfaced as isError result', async () => {
    const res = await rpc(readToken.token, {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'set_nick_note', arguments: { networkId: net.id, nick: 'bob', note: 'denied' } },
    });
    expect(res.body.result.isError).toBe(true);
    const payload = JSON.parse(res.body.result.content[0].text) as { error: string };
    expect(payload.error).toBe('forbidden');
  });

  it('tools/call against another user\'s networkId returns unknown_network as isError result', async () => {
    const { createUser } = await import('../db/users.js');
    const { createNetwork } = await import('../db/networks.js');
    const other = createUser('mcp-other');
    const otherNet = createNetwork(other.id, {
      name: 'oftc', host: 'h', port: 6697, tls: true, nick: 'o',
    }) as Network;
    const res = await rpc(rwToken.token, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'list_buffers', arguments: { networkId: otherNet.id } },
    });
    expect(res.body.result.isError).toBe(true);
    const payload = JSON.parse(res.body.result.content[0].text) as { error: string };
    expect(payload.error).toBe('unknown_network');
  });

  it('unknown method returns JSON-RPC -32601', async () => {
    const res = await rpc(readToken.token, {
      jsonrpc: '2.0', id: 9, method: 'wat',
    });
    expect(res.body.error.code).toBe(-32601);
  });

  it('tools/call without a name returns JSON-RPC -32602', async () => {
    const res = await rpc(readToken.token, {
      jsonrpc: '2.0', id: 10, method: 'tools/call', params: {},
    });
    expect(res.body.error.code).toBe(-32602);
  });

  it('notifications/initialized is acknowledged with 204 and no body', async () => {
    const res = await rpc(rwToken.token, {
      jsonrpc: '2.0', method: 'notifications/initialized',
    });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('bogus envelope (missing jsonrpc field) returns Invalid Request', async () => {
    const res = await rpc(readToken.token, { id: 11, method: 'initialize' });
    expect(res.body.error.code).toBe(-32600);
  });
});
