// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { registerVerb } from '../verbRegistry.js';
import { writableConnection } from './liveConn.js';
import { singleToken } from './args.js';

interface VerbContext {
  userId: number;
  scope: string;
}

registerVerb({
  name: 'set_nick',
  description:
    'Change your nickname on a network. The change is asynchronous and may be rejected by the ' +
    'server (nick in use, invalid, or banned) — watch the server buffer for the outcome. A nick ' +
    "the server grants is saved as the network's nick, so later connects use it. Returns " +
    '{ ok: false, error: "not-connected" } when the network is offline.',
  scope: 'read-write',
  input: {
    type: 'object',
    properties: {
      networkId: { type: 'integer' },
      nick: { type: 'string', description: 'The new nickname (no spaces).' },
    },
    required: ['networkId', 'nick'],
    additionalProperties: false,
  },
  handler(ctx: VerbContext, input: Record<string, unknown>) {
    const networkId = Number(input.networkId);
    const nick = singleToken(input.nick, {
      empty: 'empty-nick',
      malformed: 'nick-must-be-single-token',
    });
    if ('error' in nick) return { ok: false, error: nick.error };
    const conn = writableConnection(ctx.userId, networkId);
    if (!conn) return { ok: false, error: 'not-connected' };
    conn.raw(`NICK ${nick.value}`);
    return { ok: true };
  },
});
