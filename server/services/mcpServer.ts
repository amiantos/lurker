// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Request, Response } from 'express';
import express from 'express';
import { callVerb, listVerbs } from './verbRegistry.js';

// Hand-rolled MCP-over-HTTP. The transport spec ("Streamable HTTP") is mostly
// JSON-RPC 2.0 with two extras we don't need yet: server→client streaming via
// SSE (we have no subscriptions), and resumable sessions via Mcp-Session-Id
// (we're stateless — every request reauthenticates by bearer token). Single
// POST per call carries the request and returns the response inline.
//
// We implement four methods:
//   initialize                 — capability handshake.
//   notifications/initialized  — client ack of initialize. No response.
//   tools/list                 — enumerate verbs the caller can invoke.
//   tools/call                 — invoke a verb by name with arguments.
//
// JSON-RPC errors are reserved for protocol problems (bad envelope, unknown
// method, missing tool name). Verb-level failures (`{ ok: false, error: ...}`
// from send_message, `unknown_network` from the registry boundary) come back
// as a normal tool result so the agent can branch on the value rather than
// catching a protocol error.

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'lurker', version: '0.1.0' };

const router = express.Router();

interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: string;
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  data?: string,
): { jsonrpc: '2.0'; id: unknown; error: JsonRpcErrorBody } {
  const error: JsonRpcErrorBody = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

router.post('/', (req: Request, res: Response) => {
  // requireApiAuth attaches one of two credentials. An API token carries its own
  // scope; an OAuth access token (#891) has the access of a password sign-in,
  // which on this surface is read-write.
  const scope = req.apiToken?.scope ?? (req.oauthToken ? 'read-write' : null);
  if (!scope) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const apiToken = { scope };
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.json(jsonRpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const id = body.id ?? null;
  const isNotification = !('id' in body);

  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    if (isNotification) {
      res.status(204).end();
      return;
    }
    res.json(jsonRpcError(id, -32600, 'Invalid Request'));
    return;
  }

  try {
    let result: unknown;
    switch (body.method) {
      case 'initialize': {
        // Client passes its preferred protocolVersion in params; we echo back
        // the one we implement. Mismatches are negotiated client-side.
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        };
        break;
      }
      case 'notifications/initialized': {
        res.status(204).end();
        return;
      }
      case 'tools/list': {
        result = { tools: listVerbs(apiToken.scope) };
        break;
      }
      case 'tools/call': {
        const params = (body.params as Record<string, unknown>) || {};
        const name = params.name;
        const args = (params.arguments as Record<string, unknown>) || {};
        if (typeof name !== 'string' || !name) {
          res.json(jsonRpcError(id, -32602, 'Missing tool name'));
          return;
        }
        let toolPayload: unknown;
        let isError = false;
        try {
          toolPayload = callVerb(
            name,
            { userId: req.user!.id, scope: apiToken.scope, transport: 'mcp' },
            args,
          );
        } catch (err) {
          isError = true;
          const e = err as Error & { code?: string };
          toolPayload = { error: e.code || 'error', message: e.message };
        }
        result = {
          content: [{ type: 'text', text: JSON.stringify(toolPayload) }],
          isError,
        };
        break;
      }
      default: {
        if (isNotification) {
          res.status(204).end();
          return;
        }
        res.json(jsonRpcError(id, -32601, `Method not found: ${body.method as string}`));
        return;
      }
    }
    if (isNotification) {
      res.status(204).end();
      return;
    }
    res.json({ jsonrpc: '2.0', id, result });
  } catch (err) {
    if (isNotification) {
      res.status(204).end();
      return;
    }
    res.json(jsonRpcError(id, -32603, 'Internal error', (err as Error).message));
  }
});

export default router;
