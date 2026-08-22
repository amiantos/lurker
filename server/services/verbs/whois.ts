// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import ircManager from '../ircManager.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'whois',
  description:
    'Look up a nick on a network (sends WHOIS). The reply is asynchronous — it lands as numeric ' +
    'lines in the network server buffer, so follow up with recent_messages on that buffer (target ' +
    'omitted / the server buffer) to read the result. Returns { ok: false, error: "not-connected" } ' +
    'when the network is offline.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      nick: { type: 'string' },
    },
    required: ['networkId', 'nick'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const nick = typeof input.nick === 'string' ? input.nick.trim() : '';
    if (!nick) return { ok: false, error: 'empty-nick' };
    if (/[\s\r\n]/.test(nick)) return { ok: false, error: 'nick-must-be-single-token' };
    const conn = ircManager.getConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    conn.raw(`WHOIS ${nick}`);
    return { ok: true, note: 'result arrives in the server buffer; read it with recent_messages' };
  },
});
